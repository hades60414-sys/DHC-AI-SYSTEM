// Excalidraw downloads its fonts (Chinese included) from a public CDN unless told otherwise; the intranet may not
// reach it, so they are served from this site (copied into public/excalidraw/fonts). Imported before Excalidraw.
(window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = `${window.location.origin}/excalidraw/`;

export {};
