// Shared by every page: the version footer and the GitHub links. Both come from the
// build (vite.config.ts): the commit the site was built from, and the repo URL if set.

declare const __COMMIT__: string;
declare const __REPO_URL__: string;

export const COMMIT = __COMMIT__;
export const REPO_URL = __REPO_URL__;

export function fillCommon() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-version]')) {
    if (REPO_URL && COMMIT !== 'dev') {
      el.innerHTML = '';
      el.append(Object.assign(document.createElement('a'), { href: `${REPO_URL}/commit/${COMMIT}`, textContent: `version ${COMMIT}` }));
    } else {
      el.textContent = `version ${COMMIT}`;
    }
  }
  // Links to the repository disappear until a public repo URL is configured.
  for (const el of document.querySelectorAll<HTMLAnchorElement>('[data-repo]')) {
    if (REPO_URL) el.href = REPO_URL + (el.dataset.repo ?? '');
    else el.hidden = true;
  }
}
