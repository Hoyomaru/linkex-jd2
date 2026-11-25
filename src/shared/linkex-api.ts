import { bindLinkexApi } from './linkex-endpoints';
import { send, type LinkexEnvelope } from './messages';

/** 画面側から Linkex API を呼ぶための薄いラッパー。応答のキーは camelCase */
async function call<T>(method: 'get' | 'post', path: string, payload?: unknown): Promise<T> {
  const res = await send({
    type: 'linkex.call',
    method,
    path,
    ...(method === 'get' ? { params: payload } : { data: payload }),
  });
  if (!res.ok) throw new Error(res.error);
  // linkex.call は Linkex の応答をそのまま返すので、形はここで決める
  const env = res.data as LinkexEnvelope<T> | null;
  if (env && typeof env === 'object' && 'code' in env && env.code !== 0) {
    throw new Error(`Linkex: ${env.message} (code ${env.code})`);
  }
  return (env as LinkexEnvelope<T>).data;
}

export type { Traffic, Usage } from './linkex-endpoints';

/** 画面から呼ぶ Linkex API（呼び先の一覧は linkex-endpoints.ts） */
export const linkexApi = bindLinkexApi(call);

export { unwrapFile, isFolder, formatBytes } from './files';
