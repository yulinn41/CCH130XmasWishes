// server.js（整合版）

/* --- 內建/相依套件 --------------------------------------------------- */
const http = require("http");
const WebSocket = require("ws");
const express = require("express");
const path = require("path");
const fs = require("fs");

/* --- 參數 ------------------------------------------------------------- */
const PORT = process.env.PORT || 8081;

// 每張圖的處理秒數（每個週期可送幾張由 MAX_IMAGES_PER_CYCLE 決定）
const PROCESS_TIME_SEC = parseInt(process.env.PROCESS_TIME_SEC || "3", 10);//每五秒生成一次模型
// 每個處理週期要送出的上限張數
const MAX_IMAGES_PER_CYCLE = parseInt(process.env.MAX_IMAGES_PER_CYCLE || "1", 10);//依次生成三張
// 暫存上傳圖片的資料夾（預設 Persistent Disk 掛載點 /data；若沒掛載，可改環境變數）
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/data";
// 心跳間隔（採舊版設定 30 秒）
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

/* --- 確保上傳資料夾存在 ----------------------------------------------- */
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/* --- Express: 靜態檔與 SPA 路由 --------------- */
const app = express();
// CORS：讓 blob: SVG 畫進 canvas 時不被 taint
app.use((req, res, next) => {
  // 如要更嚴謹，可只針對 /Img_compressed/* 與 .png/.svg 放行
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

/* 靜態檔案目錄：WaterScapesWeb */
app.use(express.static(path.join(__dirname, "public")));
app.get("/*", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

/* --- HTTP + WS 共用同一個 server ------------------------------------- */
const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  perMessageDeflate: false,
  maxPayload: 50 * 1024 * 1024, // 50MB，視需求調整
});


/* --- 全域狀態 --------------------------------------------------------- */
let unitySocket = null;           // Unity 的 WebSocket
let unityStatus = "Disconnected"; // Unity 連線狀態
let lastSentTimeMs = Date.now();  // 上一次成功送出圖片的時間
const taskQueue = [];             // 佇列：{ id, client, filePath, enqueuedAt }

/* --- 工具：廣播 ------------------------------------------------------- */
function broadcastToClients(msg) {
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

/* --- 工具：判斷 PNG 魔術字（安全驗證） ------------------------------- */
function isPng(buffer) {
  return buffer &&
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 &&
    buffer[2] === 0x4E && buffer[3] === 0x47 &&
    buffer[4] === 0x0D && buffer[5] === 0x0A &&
    buffer[6] === 0x1A && buffer[7] === 0x0A;
}

/* --- 工具：產生任務 ID ------------------------------------------------ */
function genId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/* --- 工具：格式化時間（給 WillShowIn 提示用） ------------------------ */
function formatTimeMs(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  });
}

/* --- ETA 計算（新版邏輯，考慮處理週期與每輪限額） ------------------- */
function computeETA(positionInQueue) {
  const now = Date.now();
  const msPerCycle = PROCESS_TIME_SEC * 1000;

  // 距離下一個週期開始還要多少毫秒（依 lastSentTimeMs 對齊）
  const elapsed = now - (lastSentTimeMs || now);
  const msUntilNextCycle = msPerCycle - (elapsed % msPerCycle);

  // 這個任務在第幾個批次（0-base），每批最多 MAX_IMAGES_PER_CYCLE 張
  const batchIndex = Math.floor(positionInQueue / MAX_IMAGES_PER_CYCLE);
  const estimateMs = msUntilNextCycle + batchIndex * msPerCycle;

  return {
    estimateMs,
    estimateSec: Math.ceil(estimateMs / 1000),
    targetTimeMs: now + estimateMs,
  };
}

/* --- 傳送任務到 Unity（失敗會 requeue） ------------------------------- */
function sendImageToUnity(task) {
  // Unity 未連線：不要處理，回傳 false 讓外部決定（不 shift 或 requeue）
  if (!unitySocket || unitySocket.readyState !== WebSocket.OPEN) {
    return false;
  }

  // 讀檔與送出
  let buffer;
  try {
    buffer = fs.readFileSync(task.filePath);
  } catch (e) {
    console.error("❌ 讀檔失敗，丟棄任務", task.id, e);
    // 無法讀檔就沒必要 requeue，回報失敗
    if (task.client?.readyState === WebSocket.OPEN) {
      task.client.send(`ImageFailed:${task.id}|ReadError`);
    }
    // 嘗試清檔
    fs.rm(task.filePath, { force: true }, () => { });
    return true; // 視為已處理（不再 requeue）
  }

  try {
    console.log('[SERVER] send to Unity bytes =', buffer.length); // 🔎 對數點 #3
    unitySocket.send(buffer, { binary: true });
    lastSentTimeMs = Date.now();

    // 傳完即刪檔
    fs.rm(task.filePath, { force: true }, (err) => {
      if (err) console.error("❗ 刪除圖片檔案失敗:", task.filePath, err);
    });

    // 回覆原客戶端已派送
    if (task.client?.readyState === WebSocket.OPEN) {
      task.client.send(`ImageDispatched:${task.id}`);
    }

    return true; // 成功處理
  } catch (e) {
    console.warn("⚠️ 傳送失敗，將重試（requeue）", task.id, e?.message || e);
    // requeue 到佇列前端以維持順序
    taskQueue.unshift(task);

    // 通知原客戶端延後
    if (task.client?.readyState === WebSocket.OPEN) {
      task.client.send(`DelayedRetry:${task.id}`);
    }
    return false; // 未成功
  }
}

/* --- 週期性送圖（新版：節流 + 佇列；加上斷線保護） ------------------- */
setInterval(() => {
  // Unity 未連線：不要 shift，避免資料遺失
  if (!unitySocket || unitySocket.readyState !== WebSocket.OPEN) {
    return;
  }

  let sentThisCycle = 0;
  while (sentThisCycle < MAX_IMAGES_PER_CYCLE && taskQueue.length > 0) {
    const task = taskQueue[0]; // 先看第一個
    const ok = sendImageToUnity(task);
    if (ok) {
      // 成功（或已判定不可恢復錯誤）才真正移除
      taskQueue.shift();
      sentThisCycle++;
      console.log(`📤 已送出任務 ${task.id}，剩餘佇列：${taskQueue.length}`);
    } else {
      // 未成功但已 requeue 至前端，或 Unity 不在：為避免 busy loop，跳出本輪
      break;
    }
  }
}, PROCESS_TIME_SEC * 1000);

// 每個新連線都設 isAlive = true，收到 'pong' 時設回 true。
// 由一個全域定時器每 30 秒掃一遍：若 isAlive 為 false 就 terminate，否則先設 false 並送 ping。
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

  // 預設當成瀏覽器端；後續若收到 "Unity" 文字才標成 unity
  ws._clientType = "browser";
  console.log("👉 新客戶端已連接");
  ws.isAlive = true;

  // 第一時間回 Unity 狀態
  try { ws.send(`UnityStatus:${unityStatus}`); } catch { }

  // 收到協議級 pong
  ws.on("pong", () => {
    ws.isAlive = true;
  });

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
      return;
    }

    // B. Binary → 只接受 browser 的 PNG
    if (isBinary || Buffer.isBuffer(msg)) {
      const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);


      if (ws._clientType === "unity") {
        console.log(`[SERVER] 忽略來自 Unity 的 binary (${buf.length} bytes)`);
        return;
      }
      // 🔎 伺服器側 bytes 對數：應與前端 [SEND] PNG bytes 相同
      console.log('[SERVER] recv binary bytes =', Buffer.byteLength(buf));

      // 安全驗證：僅收 PNG
      if (!isPng(buf)) {
        try { ws.send("Error:UnsupportedFormat"); } catch { }
        return;
      }

      // 落地存檔
      const id = genId();
      const fileName = `${Date.now()}_${id}.png`;
      const filePath = path.join(UPLOAD_DIR, fileName);
      try {
        fs.writeFileSync(filePath, buf);
      } catch (e) {
        console.error("❌ 寫檔失敗：", e);
        try { ws.send(`ImageFailed:${id}|WriteError`); } catch { }
        return;
      }

      // 入佇列並回報 ETA
      const task = { id, client: ws, filePath, enqueuedAt: Date.now() };
      const positionInQueue = taskQueue.length; // 0-based：代表前面已有幾張待處理
      taskQueue.push(task);

      const { estimateMs, estimateSec, targetTimeMs } = computeETA(positionInQueue);
      // 多加 4 秒
      const DelaySec = 4;
      const extraDelayMs=DelaySec*1000;
      const payload = `WillShowIn:${estimateSec + DelaySec}|${formatTimeMs(targetTimeMs + extraDelayMs)}|${positionInQueue}|${id}`;

      try { ws.send(payload); } catch { }

      console.log(`✅ 任務加入佇列 id=${id} 檔案=${fileName} 預估 ${estimateSec}s 後送出（pos=${positionInQueue}）`);
      return;
    }

    // C. 其他文字（新版協定：無特別處理 ping；可鏡射回應）
// C. 其他文字
    const txt = msg.toString();

    // 💡 額外加入：相容舊版 Base64 格式
    if (txt.startsWith("data:image/png;base64,")) {
        console.log("收到舊版 Base64 圖片，正在轉換...");
        const base64Data = txt.replace(/^data:image\/png;base64,/, "");
        const buf = Buffer.from(base64Data, 'base64');
        
        // 這裡可以呼叫跟 B 區塊一樣的儲存與入佇列邏輯
        handleImageUpload(ws, buf); 
        return;
    }

    try { ws.send(`Echo:${txt}`); } catch { }
  });

  // 連線關閉
  ws.on("close", () => {
    if (ws === unitySocket) {
      unitySocket = null;
      unityStatus = "Disconnected";
      broadcastToClients("UnityStatus:Disconnected");
      console.warn("❌ 遊戲端端斷線");
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
