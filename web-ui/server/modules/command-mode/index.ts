// 指揮模式：聊天 websocket（modules/websocket）把 command.* 訊息與斷線交給這裡。
export { dropCommandModeSocket, handleCommandModeMessage } from './command-mode.service.js';
