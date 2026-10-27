/* =====================================================================
 *  祈福小卡 UI
 *  流程：screen1 左右切換祈福語 → screen2 輸入暱稱並上傳 → screen3 完成/倒數
 * ===================================================================== */

/* =====================================================================
 *  ▼▼▼ 可調整設定（大部分要改的東西都在這一區） ▼▼▼
 * ===================================================================== */

// 卡片底圖（所有祈福語共用）
const CARD_BASE_IMAGE = 'img/card_base.png';

// 六個祈福語
//   image    = 疊在卡片上的星星圖（上傳的圖片也用這張）
//   animated = （選填）第二、三頁要顯示的動態圖，例如 'img/blessing1.gif'
//   label    = 只用於 alt 文字
const blessings = [
    { label: '祈福語1', image: 'img/blessing1.png' },
    { label: '祈福語2', image: 'img/blessing2.png' },
    { label: '祈福語3', image: 'img/blessing3.png' },
    { label: '祈福語4', image: 'img/blessing4.png' },
    { label: '祈福語5', image: 'img/blessing5.png' },
    { label: '祈福語6', image: 'img/blessing6.png' }
];

// ★ 暱稱位置：要修正位置改這裡 ★
//   數值都是「相對整張卡片」的比例，畫面預覽和上傳的圖片會一起變
const NICK_LAYOUT = {
    centerXPercent: 0.4,    // 文字中心的左右位置：0 = 卡片最左，0.5 = 正中，1 = 最右
    centerYPercent: 0.38,   // 文字中心的上下位置：0 = 卡片最上，0.5 = 正中，1 = 最下
    fontSizePercent: 0.075, // 字的大小（卡片寬的幾 %）
    maxWidthPercent: 0.5,   // 文字最多佔卡片寬的幾 %，字太多會自動縮小
    rotateDeg: -6           // 傾斜角度：負數 = 左下右上，正數 = 左上右下，0 = 水平
};

// 暱稱文字樣式
const NICK_STYLE = {
    color: '#3b2314',
    fontWeight: 900,
    fontFamily: '"Noto Sans TC", sans-serif'
};
const NICKNAME_SUFFIX = '';   // 想要像範例「李大爺:」可改成 '：'

// 星星動畫
const STAR_ANIMATION = {
    originX: '50%',   // 擺動的旋轉中心（相對 card_base，建議對準星星中心）
    originY: '50%'
};

// 小星芒（分佈在一個橢圓範圍內，數值相對 card_base；半徑大於 0.5 會散到星星外圍）
const SPARKLES = {
    count: 16,
    centerX: 0.5,
    centerY: 0.5,
    radiusX: 0.62,
    radiusY: 0.6,
    minSize: 0.03,    // 星芒大小（相對星星寬）
    maxSize: 0.07
};

// 上傳圖片的最大寬度（高度依底圖比例）
const OUTPUT_MAX_WIDTH = 1080;

// 除錯用：設成 true，按「上傳」時會同時下載一份傳給 Unity 的 PNG，方便確認內容
const DEBUG_SAVE_UPLOAD = false;

const NICKNAME_MAX = 6;
const SWIPE_THRESHOLD = 40;     // 滑動超過幾 px 才算換頁
const FLY_OUT_DURATION = 550;   // 星星飛出後幾毫秒切到第二頁

/* ===================================================================== */

/* --- 狀態 ------------------------------------------------------------ */
let currentBlessingIndex = 0;
let userNickname = '';
let transitioning = false;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* --- WebSocket ------------------------------------------------------- */
let ws;
let unityConnected = false;
let countdownTimer = null;

function connectWebSocket() {
    ws = new WebSocket("wss://cch130xmaswishes.onrender.com/");
    ws.binaryType = "arraybuffer";

    ws.onopen = () => console.log("已連接伺服器");
    ws.onclose = () => { console.log("斷線，1 秒後重連"); setTimeout(connectWebSocket, 1000); };
    ws.onerror = err => console.error("WS 錯誤:", err);

    ws.onmessage = (ev) => {
        const msg = ev.data;
        if (typeof msg !== "string") {
            console.log("收到 Binary 資料（不顯示內容）");
            return;
        }
        if (msg.startsWith("UnityStatus:")) {
            unityConnected = msg.split(":")[1] === "Connected";
            console.log("Unity 連線狀態:", unityConnected);
            return;
        }
        if (msg.startsWith("WillShowIn:")) {
            // 格式：WillShowIn:秒|時間字串|前方張數
            const [secondsStr, timeStr, queueCountStr] = msg.replace("WillShowIn:", "").split("|");
            showInlineCountdown(parseInt(secondsStr), timeStr, parseInt(queueCountStr));
            return;
        }
        console.log("其他消息:", msg);
    };
}
connectWebSocket();

/* --- 倒數顯示 -------------------------------------------------------- */
function showInlineCountdown(seconds, timeStr) {
    const el = document.querySelector(".text-subtitle-screen3");
    if (!el) return;

    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;

    let remaining = Number.isFinite(seconds) ? seconds : 0;
    const render = () => {
        el.innerHTML =
            `您的祈福小卡預計在<br>${remaining} 秒後<br>` +
            `顯示於光雕牆上，約 ${timeStr} 出現`;
    };
    render();

    countdownTimer = setInterval(() => {
        remaining -= 1;
        if (remaining > 0) {
            render();
        } else {
            el.innerHTML = "✨祈福小卡即將出現在光雕牆上✨";
            clearInterval(countdownTimer);
            countdownTimer = null;
        }
    }, 1000);
}

/* --- 卡片圖片 -------------------------------------------------------- */
function updateCardImages() {
    const blessing = blessings[currentBlessingIndex];
    ['displayImage1', 'displayImage2', 'displayImage3'].forEach(id => {
        const img = document.getElementById(id);
        if (img && !img.src.endsWith(CARD_BASE_IMAGE)) img.src = CARD_BASE_IMAGE;
    });

    const overlay1 = document.getElementById('overlayImage1');
    if (overlay1) {
        overlay1.src = blessing.image;
        overlay1.alt = blessing.label;
    }
    ['overlayImage2', 'overlayImage3'].forEach(id => {
        const img = document.getElementById(id);
        if (img) {
            img.src = blessing.animated || blessing.image;
            img.alt = blessing.label;
        }
    });
}

/* --- 暱稱（橫式） ---------------------------------------------------- */
const measureCtx = document.createElement('canvas').getContext('2d');

// 依卡片寬度算字級，太長就縮小到 maxWidthPercent 以內
function fitNicknameFontPx(text, cardWidth) {
    let size = cardWidth * NICK_LAYOUT.fontSizePercent;
    if (!text) return size;
    const maxW = cardWidth * NICK_LAYOUT.maxWidthPercent;
    measureCtx.font = `${NICK_STYLE.fontWeight} ${size}px ${NICK_STYLE.fontFamily}`;
    const w = measureCtx.measureText(text).width;
    if (w > maxW) size *= maxW / w;
    return size;
}

function nicknameForScreen(id) {
    if (id === 'nicknameText3') return (userNickname || '匿名') + NICKNAME_SUFFIX;
    return userNickname ? userNickname + NICKNAME_SUFFIX : '';
}

function layoutNicknames() {
    ['nicknameText2', 'nicknameText3'].forEach(id => {
        const el = document.getElementById(id);
        const group = el?.closest('.star-motion');
        if (!el || !group) return;
        const text = nicknameForScreen(id);
        el.textContent = text;
        el.style.left = `${NICK_LAYOUT.centerXPercent * 100}%`;
        el.style.top = `${NICK_LAYOUT.centerYPercent * 100}%`;
        if (group.offsetWidth) {
            el.style.fontSize = `${fitNicknameFontPx(text, group.offsetWidth)}px`;
        }
    });
}

function applyStyleVars() {
    const root = document.documentElement.style;
    root.setProperty('--nick-color', NICK_STYLE.color);
    root.setProperty('--nick-weight', NICK_STYLE.fontWeight);
    root.setProperty('--nick-font', NICK_STYLE.fontFamily);
    root.setProperty('--star-origin-x', STAR_ANIMATION.originX);
    root.setProperty('--star-origin-y', STAR_ANIMATION.originY);
    root.setProperty('--nick-rotate', `${NICK_LAYOUT.rotateDeg}deg`);
}

/* --- 小星芒 ---------------------------------------------------------- */
function createSparkles() {
    document.querySelectorAll('.sparkle-layer').forEach(layer => {
        layer.innerHTML = '';
        for (let i = 0; i < SPARKLES.count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random());
            const x = SPARKLES.centerX + Math.cos(angle) * SPARKLES.radiusX * r;
            const y = SPARKLES.centerY + Math.sin(angle) * SPARKLES.radiusY * r;
            const size = SPARKLES.minSize + Math.random() * (SPARKLES.maxSize - SPARKLES.minSize);

            const s = document.createElement('span');
            s.className = 'sparkle';
            s.style.left = `${x * 100}%`;
            s.style.top = `${y * 100}%`;
            s.style.width = `${size * 100}%`;
            s.style.setProperty('--d', `${(1.4 + Math.random() * 1.6).toFixed(2)}s`);
            s.style.setProperty('--delay', `${(Math.random() * 2.5).toFixed(2)}s`);
            layer.appendChild(s);
        }
    });
}

/* --- 輪播 ------------------------------------------------------------ */
function updateIndicators() {
    document.querySelectorAll('.carousel-dot').forEach((dot, i) => {
        const active = i === currentBlessingIndex;
        dot.classList.toggle('active', active);
        dot.setAttribute('aria-current', active ? 'true' : 'false');
    });
    const counter = document.getElementById('carouselCounter');
    if (counter) counter.textContent = `第 ${currentBlessingIndex + 1} / ${blessings.length} 張`;
}

// dir：1 = 往右（下一張）、-1 = 往左（上一張）
function goToBlessing(index, dir = 1) {
    if (transitioning) return;
    const n = blessings.length;
    const target = ((index % n) + n) % n; // 頭尾相接
    if (target === currentBlessingIndex) return;

    currentBlessingIndex = target;
    updateCardImages();
    updateIndicators();

    const overlay = document.getElementById('overlayImage1');
    if (overlay) {
        overlay.classList.remove('slide-from-right', 'slide-from-left');
        void overlay.offsetWidth;
        overlay.classList.add(dir > 0 ? 'slide-from-right' : 'slide-from-left');
    }
}

function setupCarousel() {
    const dotsWrap = document.getElementById('carouselDots');
    if (dotsWrap) {
        dotsWrap.innerHTML = '';
        blessings.forEach((b, i) => {
            const dot = document.createElement('button');
            dot.className = 'carousel-dot';
            dot.setAttribute('aria-label', `第 ${i + 1} 個祈福語`);
            dot.addEventListener('click', () => {
                goToBlessing(i, i > currentBlessingIndex ? 1 : -1);
            });
            dotsWrap.appendChild(dot);
        });
    }

    document.getElementById('prevBtn')?.addEventListener('click', () => {
        goToBlessing(currentBlessingIndex - 1, -1);
    });
    document.getElementById('nextBtn')?.addEventListener('click', () => {
        goToBlessing(currentBlessingIndex + 1, 1);
    });

    // 滑動（觸控與滑鼠拖曳）
    const area = document.getElementById('swipeArea');
    if (area) {
        let startX = null, startY = null;
        area.addEventListener('pointerdown', (e) => {
            startX = e.clientX;
            startY = e.clientY;
        });
        const end = (e) => {
            if (startX === null) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            startX = startY = null;
            if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy)) return;
            if (dx < 0) goToBlessing(currentBlessingIndex + 1, 1);
            else goToBlessing(currentBlessingIndex - 1, -1);
        };
        area.addEventListener('pointerup', end);
        area.addEventListener('pointerleave', end);
        area.addEventListener('pointercancel', () => { startX = startY = null; });
    }

    document.addEventListener('keydown', (e) => {
        if (!document.getElementById('screen1')?.classList.contains('active')) return;
        if (e.key === 'ArrowLeft') goToBlessing(currentBlessingIndex - 1, -1);
        if (e.key === 'ArrowRight') goToBlessing(currentBlessingIndex + 1, 1);
    });

    updateIndicators();
}

/* --- 第一頁 → 第二頁：星星飛出去 ------------------------------------- */
function flyToScreen2() {
    if (transitioning) return;
    const motion = document.getElementById('starMotion1');
    if (reducedMotion || !motion) {
        switchScreen('2');
        return;
    }
    transitioning = true;
    motion.classList.add('fly-out');
    setTimeout(() => {
        switchScreen('2', { flyIn: true });
        motion.classList.remove('fly-out');
        transitioning = false;
    }, FLY_OUT_DURATION);
}

function resetAll() {
    currentBlessingIndex = 0;
    updateCardImages();
    updateIndicators();

    const input = document.querySelector(".nickname-input");
    if (input) input.value = "";
    userNickname = '';
    hideNicknameAlert();

    const subtitle = document.querySelector(".text-subtitle-screen3");
    if (subtitle) subtitle.innerHTML = "";
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }

    layoutNicknames();
}

/* --- 換頁 ------------------------------------------------------------ */
function switchScreen(targetId, { reset = false, flyIn = false } = {}) {
    document.querySelectorAll('.screen').forEach(s => {
        s.classList.remove('active');
        s.style.display = 'none';
    });
    const target = document.getElementById(`screen${targetId}`);
    if (!target) return;

    target.classList.add('active');
    target.style.display = 'flex';

    if (reset) resetAll();
    updateCardImages();

    if (targetId === '2') {
        const motion = document.getElementById('starMotion2');
        if (motion) {
            motion.classList.remove('fly-in');
            void motion.offsetWidth;
            if (flyIn) motion.classList.add('fly-in');
        }
    }

    requestAnimationFrame(layoutNicknames);
}

/* --- 暱稱提示 -------------------------------------------------------- */
function showNicknameAlert() {
    const input = document.querySelector('.nickname-input');
    if (!input) return;
    if (input.parentNode.querySelector('.nickname-alert')) return;
    const alertMsg = document.createElement('p');
    alertMsg.classList.add('nickname-alert');
    alertMsg.textContent = `暱稱最多只能輸入${NICKNAME_MAX}個字喔！`;
    input.parentNode.insertBefore(alertMsg, input.nextSibling);
}

function hideNicknameAlert() {
    document.querySelectorAll('.nickname-alert').forEach(el => el.remove());
}

/* --- 圖片工具 -------------------------------------------------------- */
function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`圖片載入失敗：${src}`));
        img.src = src;
    });
}

function preloadImages(urls) {
    urls.filter(Boolean).forEach(url => {
        const img = new Image();
        img.onerror = () => console.warn("❌ 預載失敗:", url);
        img.src = url;
    });
}

/* --- 合成並上傳 ------------------------------------------------------ */
// 等同 CSS object-fit: contain：圖片保持比例，縮放到框內並置中
function drawContain(ctx, img, x, y, w, h) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) return;
    const s = Math.min(w / iw, h / ih);
    const dw = iw * s, dh = ih * s;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

async function composeCard(nickname) {
    const base = await loadImage(CARD_BASE_IMAGE);
    const scale = Math.min(1, OUTPUT_MAX_WIDTH / base.naturalWidth);
    const outW = Math.round(base.naturalWidth * scale);
    const outH = Math.round(base.naturalHeight * scale);

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');

    // 1) 星星底圖（Unity 那邊不用再放底圖，這張就是完整的星星）
    ctx.drawImage(base, 0, 0, outW, outH);

    // 2) 祈福語圖：跟網頁一樣用 contain（保持比例、置中），不拉伸
    const overlay = await loadImage(blessings[currentBlessingIndex].image);
    drawContain(ctx, overlay, 0, 0, outW, outH);

    // 3) 橫式暱稱（與畫面預覽使用同一組 NICK_LAYOUT）
    const text = nickname + NICKNAME_SUFFIX;
    try {
        await document.fonts.load(`${NICK_STYLE.fontWeight} 40px ${NICK_STYLE.fontFamily}`, text);
    } catch (e) { /* 字型載入失敗就用系統字 */ }

    const fontPx = fitNicknameFontPx(text, outW);
    ctx.font = `${NICK_STYLE.fontWeight} ${fontPx}px ${NICK_STYLE.fontFamily}`;
    ctx.fillStyle = NICK_STYLE.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.save();
    ctx.translate(outW * NICK_LAYOUT.centerXPercent, outH * NICK_LAYOUT.centerYPercent);
    ctx.rotate(NICK_LAYOUT.rotateDeg * Math.PI / 180);   // 跟畫面預覽同樣的傾斜
    ctx.fillText(text, 0, 0);
    ctx.restore();

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('canvas.toBlob 失敗');

    if (DEBUG_SAVE_UPLOAD) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `upload_preview_${Date.now()}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    return blob.arrayBuffer();
}

/* --- 初始化 ---------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
    const setVh = () => {
        document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
    };
    setVh();
    window.addEventListener('resize', () => { setVh(); layoutNicknames(); });
    window.addEventListener('orientationchange', () => { setVh(); setTimeout(layoutNicknames, 200); });

    preloadImages([
        CARD_BASE_IMAGE,
        ...blessings.map(b => b.image),
        ...blessings.map(b => b.animated)
    ]);

    applyStyleVars();
    createSparkles();
    setupCarousel();
    updateCardImages();

    // 底圖載入完成、字型載入完成後重新對齊
    document.querySelectorAll('.card-base').forEach(img => {
        img.addEventListener('load', layoutNicknames);
    });
    if (document.fonts?.ready) document.fonts.ready.then(layoutNicknames);
    requestAnimationFrame(layoutNicknames);

    document.getElementById('toScreen2')?.addEventListener('click', flyToScreen2);

    document.querySelectorAll('[data-target-screen]').forEach(button => {
        button.addEventListener('click', (e) => {
            const el = e.currentTarget;
            switchScreen(el.dataset.targetScreen, { reset: el.dataset.reset === 'true' });
        });
    });

    // 暱稱輸入（處理中文輸入法組字）
    let isComposing = false;
    const nicknameInput = document.querySelector('.nickname-input');
    const enforceLimit = () => {
        const chars = Array.from(nicknameInput.value);
        if (chars.length > NICKNAME_MAX) {
            nicknameInput.value = chars.slice(0, NICKNAME_MAX).join('');
            showNicknameAlert();
        } else {
            hideNicknameAlert();
        }
    };
    const syncNickname = () => {
        userNickname = nicknameInput.value || '';
        layoutNicknames();
    };
    if (nicknameInput) {
        nicknameInput.addEventListener('compositionstart', () => { isComposing = true; });
        nicknameInput.addEventListener('compositionend', () => {
            isComposing = false;
            enforceLimit();
            syncNickname();
        });
        nicknameInput.addEventListener('input', () => {
            if (!isComposing) enforceLimit();
            syncNickname();
        });
    }

    // 上傳
    const uploadBtn = document.getElementById('uploadAndSwitch');
    if (uploadBtn) {
        uploadBtn.addEventListener('click', async () => {
            if (uploadBtn.disabled) return;
            uploadBtn.disabled = true;
            setTimeout(() => { uploadBtn.disabled = false; }, 3000);

            if (!ws || ws.readyState !== WebSocket.OPEN) {
                alert("上傳失敗，請檢查伺服器連接！");
                return;
            }
            if (!unityConnected) {
                alert("上傳失敗，遊戲尚未連接！");
                return;
            }

            try {
                const finalNickname = Array.from(nicknameInput?.value || '匿名').slice(0, NICKNAME_MAX).join('');
                userNickname = finalNickname;

                const ab = await composeCard(finalNickname);
                console.log('[SEND] PNG bytes =', ab.byteLength);
                ws.send(ab);
                console.log('✅ 圖片資料已成功傳送！');
                setTimeout(() => switchScreen('3'), 300);
            } catch (error) {
                console.error("上傳過程發生錯誤:", error);
                alert("上傳過程發生錯誤，請稍後再試！");
            }
        });
    }
});
