// Excalidraw downloads its fonts (Chinese included) from a public CDN unless told otherwise; an offline or closed
// network may not reach it, so they are served from this site (copied into public/excalidraw/fonts at build time). Imported before Excalidraw.
(window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = `${window.location.origin}/excalidraw/`;

export {};
