// The page Chrome opens after Nanobrowser is removed: a short Google Form, in English for every language, asking why.
// Its address carries nothing about the user.
import { brand } from '@src/brand';
export const UNINSTALL_FORM = brand.uninstallUrl;

/** Sets the page at worker start. */
export function setUninstallPage(): void {
  void chrome.runtime.setUninstallURL(UNINSTALL_FORM).catch(error => console.error('[uninstall] page not set', error));
}
