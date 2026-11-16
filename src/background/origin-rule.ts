/**
 * JD2のローカルAPIは、Origin ヘッダーの付いたリクエストを「Bad Origin」として断る
 * （ほかのWebページから勝手に操作されないための仕組み）。
 * 拡張機能の fetch には Origin が付いてしまうので、この拡張機能自身が 127.0.0.1 / localhost に送るときだけ外す。
 */
const RULE_ID = 1;

export async function installOriginRule(): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_ID],
    addRules: [
      {
        id: RULE_ID,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [{ header: 'origin', operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE }],
        },
        condition: {
          requestDomains: ['127.0.0.1', 'localhost'],
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: [
            chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
            chrome.declarativeNetRequest.ResourceType.OTHER,
          ],
        },
      },
    ],
  });
}
