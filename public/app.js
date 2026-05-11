// LOA-SHARE 클라이언트
// 화면 캡처 → 영역 선택 → OCR → 서버로 전송 → 공대원 데미지 수신

// ============ 상태 ============
let socket = null;
let stream = null;           // 화면 캡처 스트림
let selectedRect = null;     // 선택된 데미지 영역 (비디오 좌표계 기준)
let ocrInterval = null;      // OCR 주기 실행 타이머
let myDamage = 0;
const roster = new Map();    // socketId → { nickname, damage }
let mySocketId = null;
let ocrWorker = null;

// ============ DOM ============
const $ = (id) => document.getElementById(id);
const els = {
  nickname: $('nickname'),
  raidId: $('raidId'),
  webhook: $('webhook'),
  video: $('video'),
  canvas: $('canvas'),
  captureArea: $('captureArea'),
  selectionOverlay: $('selectionOverlay'),
  btnShareScreen: $('btnShareScreen'),
  btnSelectArea: $('btnSelectArea'),
  btnStart: $('btnStart'),
  btnStop: $('btnStop'),
  btnDiscord: $('btnDiscord'),
  myDamage: $('myDamage'),
  ocrRaw: $('ocrRaw'),
  roster: $('roster'),
  memberCount: $('memberCount'),
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  toast: $('toast'),
};

// localStorage에서 이전 입력 복원
els.nickname.value = localStorage.getItem('nickname') || '';
els.raidId.value = localStorage.getItem('raidId') || '';
els.webhook.value = localStorage.getItem('webhook') || '';
['nickname', 'raidId', 'webhook'].forEach((k) => {
  els[k].addEventListener('change', () => localStorage.setItem(k, els[k].value));
});

// ============ 토스트 ============
function toast(msg, type = '') {
  els.toast.textContent = msg;
  els.toast.className = 'toast show ' + type;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { els.toast.className = 'toast'; }, 2800);
}

// ============ 화면 공유 시작 ============
els.btnShareScreen.addEventListener('click', async () => {
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false,
    });
    els.video.srcObject = stream;
    els.captureArea.classList.add('active');
    els.btnShareScreen.textContent = '화면 공유 변경';
    els.btnSelectArea.disabled = false;

    // 사용자가 OS 메뉴에서 공유 중지 시
    stream.getVideoTracks()[0].onended = () => {
      stopOcr();
      stream = null;
      els.captureArea.classList.remove('active');
      els.btnShareScreen.textContent = '화면 공유 시작';
      els.btnSelectArea.disabled = true;
      els.btnStart.disabled = true;
      toast('화면 공유가 종료되었습니다');
    };

    toast('화면 공유가 시작되었습니다', 'success');
  } catch (e) {
    if (e.name !== 'NotAllowedError') {
      toast('화면 공유 실패: ' + e.message, 'error');
    }
  }
});

// ============ 데미지 영역 선택 ============
let isSelecting = false;
let selStart = null;
let selBox = null;

els.btnSelectArea.addEventListener('click', () => {
  if (!stream) return;
  els.captureArea.classList.add('selecting');
  toast('전투분석기의 내 데미지 숫자를 좁게 드래그하세요');
});

els.selectionOverlay.addEventListener('mousedown', (e) => {
  isSelecting = true;
  const rect = els.selectionOverlay.getBoundingClientRect();
  selStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };

  if (selBox) selBox.remove();
  selBox = document.createElement('div');
  selBox.className = 'selection-box';
  selBox.style.left = selStart.x + 'px';
  selBox.style.top = selStart.y + 'px';
  els.selectionOverlay.appendChild(selBox);
});

els.selectionOverlay.addEventListener('mousemove', (e) => {
  if (!isSelecting || !selBox) return;
  const rect = els.selectionOverlay.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const left = Math.min(selStart.x, x);
  const top = Math.min(selStart.y, y);
  const w = Math.abs(x - selStart.x);
  const h = Math.abs(y - selStart.y);
  selBox.style.left = left + 'px';
  selBox.style.top = top + 'px';
  selBox.style.width = w + 'px';
  selBox.style.height = h + 'px';
});

els.selectionOverlay.addEventListener('mouseup', (e) => {
  if (!isSelecting) return;
  isSelecting = false;
  const rect = els.selectionOverlay.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const left = Math.min(selStart.x, x);
  const top = Math.min(selStart.y, y);
  const w = Math.abs(x - selStart.x);
  const h = Math.abs(y - selStart.y);

  if (w < 10 || h < 6) {
    toast('영역이 너무 작아요. 다시 선택하세요', 'error');
    if (selBox) selBox.remove();
    selBox = null;
    return;
  }

  // 비디오 실제 해상도 기준 좌표로 변환
  const video = els.video;
  const scaleX = video.videoWidth / rect.width;
  const scaleY = video.videoHeight / rect.height;
  selectedRect = {
    x: Math.round(left * scaleX),
    y: Math.round(top * scaleY),
    w: Math.round(w * scaleX),
    h: Math.round(h * scaleY),
    // 표시용 (비율로 저장하면 패널 크기 바뀌어도 유지됨)
    pctLeft: left / rect.width,
    pctTop: top / rect.height,
    pctWidth: w / rect.width,
    pctHeight: h / rect.height,
  };

  // 선택 박스를 저장된 모양으로 전환
  selBox.className = 'saved-box';
  els.captureArea.classList.remove('selecting');
  els.btnStart.disabled = false;

  toast('영역이 선택되었습니다. 공유를 시작하세요', 'success');
});

// ============ OCR ============
async function initOcr() {
  if (ocrWorker) return ocrWorker;
  toast('OCR 엔진 로딩 중...');
  // 영어만 (숫자/쉼표 인식이면 충분, 빠름)
  ocrWorker = await Tesseract.createWorker('eng');
  await ocrWorker.setParameters({
    tessedit_char_whitelist: '0123456789,.',
  });
  return ocrWorker;
}

async function captureAndOcr() {
  if (!stream || !selectedRect) return;
  const video = els.video;
  if (video.videoWidth === 0) return;

  const { x, y, w, h } = selectedRect;
  const canvas = els.canvas;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // 비디오에서 선택 영역만 잘라서 그림
  ctx.drawImage(video, x, y, w, h, 0, 0, w, h);

  // OCR 정확도 ↑: 2배 확대 + 그레이스케일 + 대비 강화
  const upCanvas = document.createElement('canvas');
  upCanvas.width = w * 2;
  upCanvas.height = h * 2;
  const upCtx = upCanvas.getContext('2d');
  upCtx.imageSmoothingEnabled = false;
  upCtx.drawImage(canvas, 0, 0, upCanvas.width, upCanvas.height);

  const imgData = upCtx.getImageData(0, 0, upCanvas.width, upCanvas.height);
  for (let i = 0; i < imgData.data.length; i += 4) {
    const r = imgData.data[i], g = imgData.data[i + 1], b = imgData.data[i + 2];
    let v = (r * 0.3 + g * 0.59 + b * 0.11);
    v = v < 140 ? 0 : 255; // 이진화
    imgData.data[i] = imgData.data[i + 1] = imgData.data[i + 2] = v;
  }
  upCtx.putImageData(imgData, 0, 0);

  try {
    const result = await ocrWorker.recognize(upCanvas);
    const raw = result.data.text.trim();
    // 쉼표/공백 제거하고 숫자만 추출
    const digits = raw.replace(/[^0-9]/g, '');
    if (digits.length === 0) return;
    const num = parseInt(digits, 10);
    if (isNaN(num) || num < 0) return;

    els.ocrRaw.textContent = `[raw: ${raw}]`;

    // 너무 큰 변동은 OCR 오인식일 가능성 (10배 이상 점프)
    if (myDamage > 0 && (num > myDamage * 10 || num < myDamage * 0.1)) {
      // 오인식 의심, 무시
      return;
    }

    myDamage = num;
    els.myDamage.textContent = num.toLocaleString();

    if (socket && socket.connected) {
      socket.emit('damage-update', { damage: num });
    }
  } catch (e) {
    console.warn('OCR 실패:', e);
  }
}

function startOcr() {
  if (ocrInterval) return;
  ocrInterval = setInterval(captureAndOcr, 1500); // 1.5초 주기
}
function stopOcr() {
  if (ocrInterval) {
    clearInterval(ocrInterval);
    ocrInterval = null;
  }
}

// ============ 공유 시작/중지 ============
els.btnStart.addEventListener('click', async () => {
  const nickname = els.nickname.value.trim();
  const raidId = els.raidId.value.trim();
  if (!nickname || !raidId) {
    toast('닉네임과 공대 아이디를 입력하세요', 'error');
    return;
  }
  if (!selectedRect) {
    toast('데미지 영역을 먼저 선택하세요', 'error');
    return;
  }

  await initOcr();
  connectSocket(nickname, raidId);
  startOcr();
  els.btnStart.disabled = true;
  els.btnStop.disabled = false;
  els.btnStart.classList.add('pulsing');
});

els.btnStop.addEventListener('click', () => {
  stopOcr();
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  els.btnStart.disabled = false;
  els.btnStop.disabled = true;
  els.btnStart.classList.remove('pulsing');
  updateStatus(false);
  toast('공유를 중지했습니다');
});

// ============ Socket.IO ============
function connectSocket(nickname, raidId) {
  if (socket) socket.disconnect();
  socket = io();

  socket.on('connect', () => {
    mySocketId = socket.id;
    updateStatus(true);
    socket.emit('join', { raidId, nickname });
    // 나 자신도 목록에 추가
    roster.clear();
    roster.set(mySocketId, { nickname, damage: myDamage });
    renderRoster();
  });

  socket.on('disconnect', () => updateStatus(false));

  socket.on('roster', (data) => {
    roster.clear();
    for (const [sid, info] of Object.entries(data)) {
      roster.set(sid, { nickname: info.nickname, damage: info.damage || 0 });
    }
    renderRoster();
  });

  socket.on('member-joined', ({ socketId, nickname }) => {
    roster.set(socketId, { nickname, damage: 0 });
    renderRoster();
    toast(`${nickname} 입장`);
  });

  socket.on('member-left', ({ socketId }) => {
    const member = roster.get(socketId);
    if (member) toast(`${member.nickname} 퇴장`);
    roster.delete(socketId);
    renderRoster();
  });

  socket.on('damage-update', ({ socketId, nickname, damage }) => {
    roster.set(socketId, { nickname, damage });
    renderRoster();
  });

  socket.on('discord-result', ({ ok, error }) => {
    if (ok) toast('디스코드에 전송 완료', 'success');
    else toast('디스코드 전송 실패: ' + error, 'error');
  });
}

function updateStatus(connected) {
  els.statusDot.classList.toggle('on', connected);
  els.statusText.textContent = connected ? 'CONNECTED' : 'DISCONNECTED';
}

// ============ 공대원 목록 렌더 ============
function renderRoster() {
  // 나의 최신 데미지를 roster에 반영
  if (mySocketId && roster.has(mySocketId)) {
    const me = roster.get(mySocketId);
    me.damage = myDamage;
  }

  const members = Array.from(roster.entries())
    .map(([sid, m]) => ({ sid, ...m }))
    .sort((a, b) => b.damage - a.damage);

  els.memberCount.textContent = `${members.length} / 8`;

  if (members.length === 0) {
    els.roster.innerHTML = '<div class="empty"><div class="icon">⚔</div>공대 입장 시 공대원들의 데미지가 여기에 표시됩니다.</div>';
    return;
  }

  const max = members[0].damage || 1;
  const total = members.reduce((s, m) => s + m.damage, 0);

  els.roster.innerHTML = members.map((m, i) => {
    const pct = total > 0 ? ((m.damage / total) * 100).toFixed(1) : '0.0';
    const barPct = (m.damage / max) * 100;
    const isMe = m.sid === mySocketId;
    const rankClass = i < 3 ? `rank-${i + 1}` : '';
    return `
      <div class="member ${rankClass} ${isMe ? 'me' : ''}">
        <div class="rank">${i + 1}</div>
        <div class="info">
          <div class="nick">${escapeHtml(m.nickname)}</div>
          <div class="bar-track"><div class="bar-fill" style="width: ${barPct}%;"></div></div>
        </div>
        <div class="damage">
          ${m.damage.toLocaleString()}
          <span class="pct">${pct}%</span>
        </div>
      </div>
    `;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ============ 디스코드 박제 ============
els.btnDiscord.addEventListener('click', () => {
  const url = els.webhook.value.trim();
  if (!url) {
    toast('디스코드 웹훅 URL을 입력하세요', 'error');
    return;
  }
  if (!socket || !socket.connected) {
    toast('먼저 공유를 시작하세요', 'error');
    return;
  }
  socket.emit('send-to-discord', { webhookUrl: url });
  toast('디스코드로 전송 중...');
});
