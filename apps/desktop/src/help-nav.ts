// How any part of the window opens the help at an article: the window registers how it goes there, and a "?" beside
// a control calls it with the article that explains the control.
let opener: ((article?: string) => void) | null = null;

export function setHelpOpener(open: ((article?: string) => void) | null) {
  opener = open;
}
export function openHelp(article?: string) {
  opener?.(article);
}
