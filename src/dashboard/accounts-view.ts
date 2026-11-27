/**
 * 専用ページの「Linkexのアカウント」の一覧と、概要の上部に出すアカウントの注意。
 * 一覧は Linkex Web版に覚えさせてあるもの（読むだけ）。拡張機能で選べるのは、切り替えに使うかどうかだけ。
 */
import { expiresAt, type AccountRecord, type AccountWarning, type LinkexAccount } from '../shared/accounts';
import { formatBytes } from '../shared/files';
import { send, type AccountsView } from '../shared/messages';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const HOUR = 60 * 60 * 1000;

function when(at: number): string {
  const d = new Date(at);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 転送量の欄。今のアカウントは /traffic の値、ほかは記録のうち新しいほうを時刻付きで */
function trafficText(a: LinkexAccount, rec: AccountRecord | undefined, current: { used: number; total: number } | null): string {
  if (rec?.exhaustedAt !== undefined) return `尽きた（${when(rec.exhaustedAt)}）`;
  const left = (used: number, total: number) => `残り ${formatBytes(Math.max(0, total - used))} / ${formatBytes(total)}`;
  if (current) return left(current.used, current.total);
  if (rec?.lastTraffic) return `${left(rec.lastTraffic.used, rec.lastTraffic.total)}（${when(rec.lastTraffic.at)} 時点）`;
  if (a.cachedTraffic && a.cachedTraffic.total > 0) return `${left(a.cachedTraffic.used, a.cachedTraffic.total)}（Linkexが最後に見た値）`;
  return '未確認';
}

function expiryText(a: LinkexAccount): { text: string; warn: boolean } {
  const left = expiresAt(a) - Date.now();
  if (!Number.isFinite(left)) return { text: '期限 不明', warn: false };
  if (left <= 0) return { text: '期限切れ', warn: true };
  const days = Math.floor(left / (24 * HOUR));
  return { text: days >= 1 ? `期限まで ${days}日` : `期限まで ${Math.floor(left / HOUR)}時間`, warn: left < 72 * HOUR };
}

export function warningText(w: AccountWarning): string {
  switch (w.kind) {
    case 'expiring': {
      const span = w.hoursLeft >= 24 ? `${Math.floor(w.hoursLeft / 24)}日（${w.hoursLeft}時間）` : `${w.hoursLeft}時間`;
      return `${w.name} はあと${span}で Linkex の一覧から消えます。処理を動かしていれば、自動で使って期限を延ばします`;
    }
    case 'keepAliveFailed':
      return `${w.name} の期限を延ばせませんでした。Linkex で ${w.name} に切り替えて使うか、ログインし直してください`;
    case 'gone':
      return `${w.name} が Linkex の一覧から消えました。使うには、ログインし直して足してください`;
  }
}

export function setupAccountsView(log: (label: string, value?: unknown) => void) {
  const table = $<HTMLTableElement>('accounts-table');
  const empty = $('accounts-empty');
  const toggle = $<HTMLInputElement>('switch-accounts');
  const warnings = $('account-warnings');

  toggle.addEventListener('change', async () => {
    const res = await send({ type: 'settings.set', patch: { switchAccounts: toggle.checked } });
    if (!res.ok) log(`設定の保存に失敗: ${res.error}`);
  });

  function renderWarnings(list: AccountWarning[]) {
    warnings.replaceChildren(
      ...list.map((w) => {
        const row = document.createElement('div');
        row.className = 'account-warning';
        const span = document.createElement('span');
        span.textContent = warningText(w);
        row.append(span);
        if (w.kind === 'gone') {
          const button = document.createElement('button');
          button.className = 'small';
          button.textContent = '知らせを消す';
          button.addEventListener('click', async () => {
            const res = await send({ type: 'accounts.forget', uid: w.uid });
            if (!res.ok) log(`消せませんでした: ${res.error}`);
            await refresh();
          });
          row.append(button);
        }
        return row;
      }),
    );
    warnings.hidden = list.length === 0;
  }

  function render(view: AccountsView, currentTraffic: { used: number; total: number } | null) {
    toggle.checked = view.switchAccounts;
    renderWarnings(view.warnings);
    const s = view.snapshot;
    const tbody = table.tBodies[0];
    if (!s || s.accounts.length === 0) {
      tbody.replaceChildren();
      table.hidden = true;
      empty.hidden = false;
      empty.textContent = s
        ? 'Linkex に覚えさせてあるアカウントがありません'
        : 'Linkexのアカウントを読めませんでした（Linkexにログインしているか確かめてください）';
      return;
    }
    table.hidden = false;
    empty.hidden = true;
    const disabled = new Set(view.disabled);
    tbody.replaceChildren(
      ...s.accounts.map((a) => {
        const tr = document.createElement('tr');
        const current = a.uid === s.currentUid;

        const onCell = document.createElement('td');
        const label = document.createElement('label');
        label.className = 'check';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !disabled.has(a.uid);
        box.setAttribute('aria-label', `${a.name} を切り替えに使う`);
        box.addEventListener('change', async () => {
          const res = await send({ type: 'accounts.setEnabled', uid: a.uid, on: box.checked });
          if (!res.ok) log(`設定の保存に失敗: ${res.error}`);
        });
        label.append(box, document.createTextNode(a.name));
        onCell.append(label);
        if (a.email && a.email !== a.name) {
          const mail = document.createElement('div');
          mail.className = 'muted small-text';
          mail.textContent = a.email;
          onCell.append(mail);
        }

        const stateCell = document.createElement('td');
        stateCell.textContent = current ? '使用中' : '';
        if (current) stateCell.className = 'ok';

        const trafficCell = document.createElement('td');
        trafficCell.textContent = trafficText(a, view.records[a.uid], current ? currentTraffic : null);

        const expiry = expiryText(a);
        const expiryCell = document.createElement('td');
        expiryCell.textContent = expiry.warn ? `${expiry.text} ⚠` : expiry.text;
        if (expiry.warn) expiryCell.className = 'warn-text';

        tr.append(onCell, stateCell, trafficCell, expiryCell);
        return tr;
      }),
    );
  }

  /** 一覧を読み直す。今のアカウントの転送量は、呼ぶ側が取ったものを使う */
  let lastTraffic: { used: number; total: number } | null = null;
  async function refresh(currentTraffic?: { used: number; total: number } | null) {
    if (currentTraffic !== undefined) lastTraffic = currentTraffic;
    const res = await send({ type: 'accounts.list' });
    if (!res.ok) {
      empty.hidden = false;
      empty.textContent = `アカウントを読めませんでした: ${res.error}`;
      return;
    }
    render(res.data, lastTraffic);
  }

  return { refresh };
}
