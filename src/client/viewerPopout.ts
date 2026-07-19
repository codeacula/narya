// Opens a viewer's spotlight in its own small window. The unique window name means
// a second click opens a second window instead of reusing the first, so several
// viewers can be kept side by side.
export function openViewerPopout(login: string): void {
  const windowName = `viewer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  window.open(`/viewer?login=${encodeURIComponent(login)}`, windowName, 'width=380,height=560');
}
