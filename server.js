// server.js（整合版）
//
// 流程：
//   網頁上傳 PNG → 存檔 → 立刻轉給 Unity（先送 "Task:{id}"，再送圖片）
//   Unity 收到後算出「幾秒後出現在牆上」→ 回傳 "Eta:{id}|{秒}|{前面張數}"
//   server 把它轉成 "WillShowIn:{秒}|{HH:mm}|{前面張數}|{id}" 給上傳的那支手機
//
// 播放節奏由 Unity 的 StarManager 控制，server 不再自己節流，
// 所以 Unity 改了任何秒數，倒數都會自動跟著準。

/* --- 內建/相依套件 --------------------------------------------------- */
const http = require("http");
const WebSocket = require("ws");
const express = require("express");
const path = require("path");
const fs = require("fs");

/* --- 參數 ------------------------------------------------------------- */
const PORT = process.env.PORT || 8081;

// 暫存上傳圖片的資料夾（預設 Persistent Disk 掛載點；沒掛載可改環境變數）
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "data");

// Unity 幾秒內沒回報秒數，就先用估計值回覆網頁
const ETA_TIMEOUT_MS = parseInt(process.env.ETA_TIMEOUT_MS || "3000", 10);
// 估計值用的一批循環秒數 / 每批張數 / 一批開始到星星出現的秒數（只在 Unity 沒回應時使用）
const FALLBACK_CYCLE_SEC = parseFloat(process.env.FALLBACK_CYCLE_SEC || "15.3");
const FALLBACK_PER_BATCH = parseInt(process.env.FALLBACK_PER_BATCH || "2", 10);
const FALLBACK_LAUNCH_SEC = parseFloat(process.env.FALLBACK_LAUNCH_SEC || "3.3");

// 心跳間隔
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/* --- Express: 靜態檔與 SPA 路由 --------------- */
const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/*", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

/* --- HTTP + WS 共用同一個 server ------------------------------------- */
const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  perMessageDeflate: false,
  maxPayload: 50 * 1024 * 1024,
});

/* --- 全域狀態 --------------------------------------------------------- */
let unitySocket = null;           // Unity 的 WebSocket
let unityStatus = "Disconnected"; // Unity 連線狀態
const taskQueue = [];             // Unity 斷線時暫存：{ id, client, filePath, enqueuedAt }
const awaitingEta = new Map();    // 已送給 Unity、等它回報秒數：id → { client, timer }

/* --- 工具 ------------------------------------------------------------- */
function broadcastToClients(msg) {
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

function isPng(buffer) {
  return buffer &&
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 &&
    buffer[2] === 0x4E && buffer[3] === 0x47 &&
    buffer[4] === 0x0D && buffer[5] === 0x0A &&
    buffer[6] === 0x1A && buffer[7] === 0x0A;
}

function genId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatTimeMs(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  });
}

function safeSend(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(msg); } catch { }
  }
}

/* --- 回覆網頁 WillShowIn ---------------------------------------------- */
function sendWillShowIn(client, id, seconds, ahead) {
  const sec = Math.max(0, Math.ceil(seconds));
  const timeStr = formatTimeMs(Date.now() + sec * 1000);
  safeSend(client, `WillShowIn:${sec}|${timeStr}|${ahead}|${id}`);
}

// Unity 沒回應時的粗估（不知道 Unity 目前跑到哪，最多可能差一個循環）
function fallbackEta(ahead) {
  const batches = Math.floor(Math.max(0, ahead) / Math.max(1, FALLBACK_PER_BATCH));
  return FALLBACK_CYCLE_SEC * (batches + 0.5) + FALLBACK_LAUNCH_SEC;
}

/* --- 傳送任務到 Unity ------------------------------------------------- */
function sendImageToUnity(task) {
  if (!unitySocket || unitySocket.readyState !== WebSocket.OPEN) return false;

  let buffer;
  try {
    buffer = fs.readFileSync(task.filePath);
  } catch (e) {
    console.error("❌ 讀檔失敗，丟棄任務", task.id, e);
    safeSend(task.client, `ImageFailed:${task.id}|ReadError`);
    fs.rm(task.filePath, { force: true }, () => { });
    return true; // 視為已處理
  }

  try {
    // 先告訴 Unity 下一張圖的 id，再送圖片（同一條連線，順序有保證）
    unitySocket.send(`Task:${task.id}`);
    unitySocket.send(buffer, { binary: true });
    console.log(`[SERVER] 送出圖片給 Unity id=${task.id} bytes=${buffer.length}`);

    fs.rm(task.filePath, { force: true }, (err) => {
      if (err) console.error("❗ 刪除圖片檔案失敗:", task.filePath, err);
    });

    safeSend(task.client, `ImageDispatched:${task.id}`);

    // 等 Unity 回報秒數；逾時就先用估計值
    const timer = setTimeout(() => {
      if (!awaitingEta.has(task.id)) return;
      awaitingEta.delete(task.id);
      const ahead = awaitingEta.size;
      console.warn(`⏱ Unity 未回報 ETA，使用估計值 id=${task.id}`);
      sendWillShowIn(task.client, task.id, fallbackEta(ahead), ahead);
    }, ETA_TIMEOUT_MS);
    awaitingEta.set(task.id, { client: task.client, timer });

    return true;
  } catch (e) {
    console.warn("⚠️ 傳送失敗，稍後重試", task.id, e?.message || e);
    safeSend(task.client, `DelayedRetry:${task.id}`);
    return false;
  }
}

// 把暫存的任務依序全部送給 Unity
function flushQueue() {
  while (taskQueue.length > 0) {
    if (!sendImageToUnity(taskQueue[0])) break;
    const t = taskQueue.shift();
    console.log(`📤 已送出任務 ${t.id}，剩餘暫存：${taskQueue.length}`);
  }
}

/* --- 處理網頁上傳的圖片 ---------------------------------------------- */
function handleImageUpload(ws, buf) {
  if (!isPng(buf)) {
    safeSend(ws, "Error:UnsupportedFormat");
    return;
  }

  const id = genId();
  const fileName = `${Date.now()}_${id}.png`;
  const filePath = path.join(UPLOAD_DIR, fileName);
  try {
    fs.writeFileSync(filePath, buf);
  } catch (e) {
    console.error("❌ 寫檔失敗：", e);
    safeSend(ws, `ImageFailed:${id}|WriteError`);
    return;
  }

  taskQueue.push({ id, client: ws, filePath, enqueuedAt: Date.now() });
  console.log(`✅ 任務加入 id=${id} 檔案=${fileName}`);

  if (unitySocket && unitySocket.readyState === WebSocket.OPEN) {
    flushQueue();   // Unity 在線：立刻轉送，WillShowIn 由 Unity 回報後再回覆
  } else {
    // Unity 不在：先回一個粗估，等 Unity 連上會自動送出
    const ahead = taskQueue.length - 1;
    sendWillShowIn(ws, id, fallbackEta(ahead), ahead);
  }
}

/* --- 處理 Unity 回報的 ETA -------------------------------------------- */
// 格式：Eta:{id}|{秒}|{前面張數}
function handleUnityEta(txt) {
  const [id, secStr, aheadStr] = txt.slice(4).split("|");
  const entry = awaitingEta.get(id);
  if (!entry) return; // 已逾時用估計值回覆過了

  clearTimeout(entry.timer);
  awaitingEta.delete(id);

  const sec = parseFloat(secStr);
  const ahead = parseInt(aheadStr, 10) || 0;
  sendWillShowIn(entry.client, id, Number.isFinite(sec) ? sec : fallbackEta(ahead), ahead);
  console.log(`🕒 Unity 回報 id=${id} 約 ${secStr} 秒後出現（前面 ${ahead} 張）`);
}

/* --- 心跳 ------------------------------------------------------------- */
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      console.warn("⚠️ 連線心跳逾時，強制關閉。");
      return ws.terminate();
    }
    ws.isAlive = false;
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.ping();
      } catch (e) {
        console.warn("⚠️ ping 失敗，關閉連線。", e?.message || e);
        ws.terminate();
      }
    }
  });
}, HEARTBEAT_INTERVAL_MS);

/* --- WebSocket 連線處理 ------------------------------------------------ */
wss.on("connection", (ws) => {
  ws._clientType = "browser";
  ws.isAlive = true;
  console.log("👉 新客戶端已連接");

  safeSend(ws, `UnityStatus:${unityStatus}`);

  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("error", (err) => {
    console.error("❌ WebSocket 個別連線錯誤:", err);
  });

  ws.on("message", (msg, isBinary) => {
    // A. Unity 身分認證
    if (!isBinary && msg.toString() === "Unity") {
      ws._clientType = "unity";
      unitySocket = ws;
      unityStatus = "Connected";
      broadcastToClients("UnityStatus:Connected");
      console.log("✅ Unity 端已認證");
      flushQueue(); // 把斷線期間暫存的圖片送過去
      return;
    }

    // B. Binary → 只接受 browser 的 PNG
    if (isBinary) {
      if (ws._clientType === "unity") {
        console.log("[SERVER] 忽略來自 Unity 的 binary");
        return;
      }
      const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
      console.log('[SERVER] recv binary bytes =', buf.length);
      handleImageUpload(ws, buf);
      return;
    }

    // C. 文字
    const txt = msg.toString();

    // Unity 回報預計出現秒數
    if (ws._clientType === "unity" && txt.startsWith("Eta:")) {
      handleUnityEta(txt);
      return;
    }

    // Unity 心跳
    if (ws._clientType === "unity" && txt === "ping") return;

    // 相容舊版 Base64 格式
    if (txt.startsWith("data:image/png;base64,")) {
      console.log("收到舊版 Base64 圖片，正在轉換...");
      const buf = Buffer.from(txt.replace(/^data:image\/png;base64,/, ""), "base64");
      handleImageUpload(ws, buf);
      return;
    }

    safeSend(ws, `Echo:${txt}`);
  });

  ws.on("close", () => {
    if (ws === unitySocket) {
      unitySocket = null;
      unityStatus = "Disconnected";
      broadcastToClients("UnityStatus:Disconnected");
      console.warn("❌ 遊戲端斷線");
    } else {
      console.log("❌ 一般客戶端斷線");
    }
  });
});

/* --- 啟動 ------------------------------------------------------------- */
server.listen(PORT, () => {
  console.log(`🌐 Server ready → http://localhost:${PORT}`);
});

/* --- 全域錯誤攔截 ----------------------------------------------------- */
process.on("uncaughtException", err => {
  console.error("🛑 Uncaught Exception:", err);
});
process.on("unhandledRejection", err => {
  console.error("🛑 Unhandled Rejection:", err);
});
