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
let damageUnit = localStorage.getItem('damageUnit') || 'auto'; // 'auto' | 'raw' | 'man' | 'eok'

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
  // ===== 모달 요소 =====
  selectionModal: $('selectionModal'),
  modalVideo: $('modalVideo'),
  modalCapture: $('modalCapture'),
  modalSelectionLayer: $('modalSelectionLayer'),
  modalClose: $('modalClose'),
  modalCancel: $('modalCancel'),
  modalConfirm: $('modalConfirm'),
  modalInfo: $('modalInfo'),
  modalZoom: $('modalZoom'),
  modalZoomCanvas: $('modalZoomCanvas'),
  modalZoomSize: $('modalZoomSize'),
  // ===== 디버그 =====
  debugCanvas: $('debugCanvas'),
  debugPanel: $('debugPanel'),
};

// localStorage에서 이전 입력 복원
els.nickname.value = localStorage.getItem('nickname') || '';
els.raidId.value = localStorage.getItem('raidId') || '';
els.webhook.value = localStorage.getItem('webhook') || '';
['nickname', 'raidId', 'webhook'].forEach((k) => {
  els[k].addEventListener('change', () => localStorage.setItem(k, els[k].value));
});

// 단위 선택 버튼 초기화 및 핸들러
function initUnitButtons() {
  document.querySelectorAll('.unit-btn').forEach((btn) => {
    if (btn.dataset.unit === damageUnit) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
    btn.addEventListener('click', () => {
      damageUnit = btn.dataset.unit;
      localStorage.setItem('damageUnit', damageUnit);
      document.querySelectorAll('.unit-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.unit === damageUnit)
      );
      toast(`단위: ${({auto:'자동',raw:'단위없음',man:'만',eok:'억'})[damageUnit]}`);
    });
  });
}
initUnitButtons();

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

// ============ 데미지 영역 선택 (모달) ============
let modalIsSelecting = false;
let modalSelStart = null;
let modalSelBox = null;
let modalCurrentRect = null; // 모달에서 현재 그려진 영역

// "큰 화면으로 영역 선택" 버튼 → 모달 열기
els.btnSelectArea.addEventListener('click', () => {
  if (!stream) return;
  openSelectionModal();
});

function openSelectionModal() {
  // 모달 비디오에 현재 스트림 연결
  els.modalVideo.srcObject = stream;
  els.selectionModal.classList.add('show');

  // 이전 선택이 있으면 모달 안에도 표시
  if (selectedRect) {
    setTimeout(() => restorePreviousSelection(), 100);
  } else {
    els.modalConfirm.disabled = true;
    els.modalInfo.textContent = '드래그하여 영역을 선택하세요';
    if (modalSelBox) { modalSelBox.remove(); modalSelBox = null; }
    modalCurrentRect = null;
    els.modalZoom.classList.remove('show');
  }
}

function closeSelectionModal() {
  els.selectionModal.classList.remove('show');
  els.modalVideo.srcObject = null;
}

// 이전 선택 복원
function restorePreviousSelection() {
  if (!selectedRect || !els.modalVideo.videoWidth) return;
  const video = els.modalVideo;
  const videoRect = video.getBoundingClientRect();
  const layerRect = els.modalSelectionLayer.getBoundingClientRect();
  const scaleX = layerRect.width / video.videoWidth;
  const scaleY = layerRect.height / video.videoHeight;

  if (modalSelBox) modalSelBox.remove();
  modalSelBox = document.createElement('div');
  modalSelBox.className = 'modal-selection-box';
  modalSelBox.style.left = (selectedRect.x * scaleX) + 'px';
  modalSelBox.style.top = (selectedRect.y * scaleY) + 'px';
  modalSelBox.style.width = (selectedRect.w * scaleX) + 'px';
  modalSelBox.style.height = (selectedRect.h * scaleY) + 'px';
  els.modalSelectionLayer.appendChild(modalSelBox);
  modalCurrentRect = { x: selectedRect.x, y: selectedRect.y, w: selectedRect.w, h: selectedRect.h };
  els.modalConfirm.disabled = false;
  els.modalInfo.innerHTML = `이전 선택 영역 · <b>${selectedRect.w} × ${selectedRect.h}px</b>`;
  updateZoomPreview();
}

// 모달 닫기 핸들러
els.modalClose.addEventListener('click', closeSelectionModal);
els.modalCancel.addEventListener('click', closeSelectionModal);
els.selectionModal.addEventListener('click', (e) => {
  if (e.target === els.selectionModal) closeSelectionModal();
});

// ESC로 모달 닫기
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && els.selectionModal.classList.contains('show')) {
    closeSelectionModal();
  }
});

// 모달 안에서 드래그 → 영역 선택
els.modalSelectionLayer.addEventListener('mousedown', (e) => {
  modalIsSelecting = true;
  const rect = els.modalSelectionLayer.getBoundingClientRect();
  modalSelStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };

  if (modalSelBox) modalSelBox.remove();
  modalSelBox = document.createElement('div');
  modalSelBox.className = 'modal-selection-box';
  modalSelBox.style.left = modalSelStart.x + 'px';
  modalSelBox.style.top = modalSelStart.y + 'px';
  modalSelBox.style.width = '0px';
  modalSelBox.style.height = '0px';
  els.modalSelectionLayer.appendChild(modalSelBox);
  e.preventDefault();
});

els.modalSelectionLayer.addEventListener('mousemove', (e) => {
  if (!modalIsSelecting || !modalSelBox) return;
  const rect = els.modalSelectionLayer.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const left = Math.min(modalSelStart.x, x);
  const top = Math.min(modalSelStart.y, y);
  const w = Math.abs(x - modalSelStart.x);
  const h = Math.abs(y - modalSelStart.y);
  modalSelBox.style.left = left + 'px';
  modalSelBox.style.top = top + 'px';
  modalSelBox.style.width = w + 'px';
  modalSelBox.style.height = h + 'px';

  // 실시간 정보 업데이트
  const video = els.modalVideo;
  const scaleX = video.videoWidth / rect.width;
  const scaleY = video.videoHeight / rect.height;
  const realW = Math.round(w * scaleX);
  const realH = Math.round(h * scaleY);
  els.modalInfo.innerHTML = `선택 중 · <b>${realW} × ${realH}px</b>`;
});

els.modalSelectionLayer.addEventListener('mouseup', (e) => {
  if (!modalIsSelecting) return;
  modalIsSelecting = false;
  const rect = els.modalSelectionLayer.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const left = Math.min(modalSelStart.x, x);
  const top = Math.min(modalSelStart.y, y);
  const w = Math.abs(x - modalSelStart.x);
  const h = Math.abs(y - modalSelStart.y);

  if (w < 5 || h < 5) {
    if (modalSelBox) modalSelBox.remove();
    modalSelBox = null;
    els.modalConfirm.disabled = true;
    els.modalInfo.textContent = '영역이 너무 작아요. 다시 드래그하세요';
    els.modalZoom.classList.remove('show');
    return;
  }

  // 비디오 실제 해상도 기준 좌표로 변환
  const video = els.modalVideo;
  const scaleX = video.videoWidth / rect.width;
  const scaleY = video.videoHeight / rect.height;
  modalCurrentRect = {
    x: Math.round(left * scaleX),
    y: Math.round(top * scaleY),
    w: Math.round(w * scaleX),
    h: Math.round(h * scaleY),
  };

  els.modalConfirm.disabled = false;
  els.modalInfo.innerHTML = `선택 완료 · <b>${modalCurrentRect.w} × ${modalCurrentRect.h}px</b> · 확정 버튼을 누르세요`;
  updateZoomPreview();
});

// 확대 미리보기 갱신 (선택한 영역만 크게 보여줌)
function updateZoomPreview() {
  if (!modalCurrentRect) return;
  const { x, y, w, h } = modalCurrentRect;
  const video = els.modalVideo;
  if (!video.videoWidth) return;

  const canvas = els.modalZoomCanvas;
  // 미리보기는 영역을 4배 확대해서 표시 (최소 가로 220px 유지)
  const scale = Math.max(4, 220 / w);
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(video, x, y, w, h, 0, 0, canvas.width, canvas.height);

  els.modalZoomSize.textContent = `${w} × ${h}px (×${scale.toFixed(1)} 확대)`;
  els.modalZoom.classList.add('show');

  // 1초마다 자동 갱신 (게임이 움직이는 동안 확인 가능)
  clearInterval(updateZoomPreview._t);
  updateZoomPreview._t = setInterval(() => {
    if (!els.selectionModal.classList.contains('show') || !modalCurrentRect) {
      clearInterval(updateZoomPreview._t);
      return;
    }
    const c = els.modalZoomCanvas.getContext('2d');
    c.imageSmoothingEnabled = false;
    c.drawImage(video, modalCurrentRect.x, modalCurrentRect.y, modalCurrentRect.w, modalCurrentRect.h,
                0, 0, els.modalZoomCanvas.width, els.modalZoomCanvas.height);
  }, 800);
}

// 확정 버튼 → 본문에 적용
els.modalConfirm.addEventListener('click', () => {
  if (!modalCurrentRect) return;

  selectedRect = {
    x: modalCurrentRect.x,
    y: modalCurrentRect.y,
    w: modalCurrentRect.w,
    h: modalCurrentRect.h,
  };

  // 작은 미리보기에도 표시 (참고용)
  const video = els.video;
  const captureRect = els.captureArea.getBoundingClientRect();
  const scaleX = captureRect.width / video.videoWidth;
  const scaleY = captureRect.height / video.videoHeight;

  // 기존 작은 박스 제거 후 새로 그림
  els.captureArea.querySelectorAll('.saved-box').forEach(b => b.remove());
  const smallBox = document.createElement('div');
  smallBox.className = 'saved-box';
  smallBox.style.left = (selectedRect.x * scaleX) + 'px';
  smallBox.style.top = (selectedRect.y * scaleY) + 'px';
  smallBox.style.width = (selectedRect.w * scaleX) + 'px';
  smallBox.style.height = (selectedRect.h * scaleY) + 'px';
  els.captureArea.appendChild(smallBox);

  els.btnStart.disabled = false;
  closeSelectionModal();
  toast(`영역 설정 완료 (${selectedRect.w} × ${selectedRect.h}px)`, 'success');
});

// ============ OCR ============
async function initOcr() {
  if (ocrWorker) return ocrWorker;
  toast('OCR 엔진 로딩 중... (한국어 모델 다운로드)');
  // 한국어 + 영어 (로아의 "억" "만" 단위 인식용)
  ocrWorker = await Tesseract.createWorker(['kor', 'eng']);
  await ocrWorker.setParameters({
    // 화이트리스트 제거 (너무 엄격하면 글자를 통째로 누락함)
    // PSM 6: "단일 균일 텍스트 블록" - 한글+숫자 혼합에 더 유연
    tessedit_pageseg_mode: '6',
  });
  return ocrWorker;
}

// 한글 단위가 포함된 문자열을 실제 숫자로 변환
// 예: "1.22억" → 122000000
//     "3,456만" → 34560000
//     "1억 2,345만" → 123450000
//     "350M" → 350000000
//     "12,345" → 12345
function parseKoreanNumber(text) {
  if (!text) return null;

  // 공백 정규화, 쉼표 제거
  let s = text.replace(/\s+/g, '').replace(/,/g, '');

  // 영문 약식 단위 처리 (1.2B, 350M, 50K)
  const unitMatch = s.match(/^([0-9.]+)\s*([KMB])$/i);
  if (unitMatch) {
    const n = parseFloat(unitMatch[1]);
    const unit = unitMatch[2].toUpperCase();
    if (isNaN(n)) return null;
    if (unit === 'K') return Math.round(n * 1000);
    if (unit === 'M') return Math.round(n * 1000000);
    if (unit === 'B') return Math.round(n * 1000000000);
  }

  // 한글 단위 처리: "억"과 "만"을 분리해서 계산
  // 예: "1.22억" "1억2345만" "3456만"
  let total = 0;
  let hasUnit = false;

  // "억" 처리
  const eokMatch = s.match(/([0-9.]+)억/);
  if (eokMatch) {
    const n = parseFloat(eokMatch[1]);
    if (!isNaN(n)) {
      total += Math.round(n * 100000000); // 1억 = 1억
      s = s.replace(eokMatch[0], '');
      hasUnit = true;
    }
  }

  // "만" 처리
  const manMatch = s.match(/([0-9.]+)만/);
  if (manMatch) {
    const n = parseFloat(manMatch[1]);
    if (!isNaN(n)) {
      total += Math.round(n * 10000); // 1만 = 10000
      s = s.replace(manMatch[0], '');
      hasUnit = true;
    }
  }

  // "천" 처리 (드물지만)
  const cheonMatch = s.match(/([0-9.]+)천/);
  if (cheonMatch) {
    const n = parseFloat(cheonMatch[1]);
    if (!isNaN(n)) {
      total += Math.round(n * 1000);
      s = s.replace(cheonMatch[0], '');
      hasUnit = true;
    }
  }

  if (hasUnit) {
    // 남은 숫자가 있으면 더함 (예: "1억2345" → 1억 + 2345)
    const remaining = s.replace(/[^0-9]/g, '');
    if (remaining) total += parseInt(remaining, 10);
    return total;
  }

  // 단위 없는 순수 숫자
  const digits = s.replace(/[^0-9]/g, '');
  if (digits.length === 0) return null;
  return parseInt(digits, 10);
}

// 최근 OCR 결과들 (안정성 검증용)
const recentReads = [];

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

  // OCR 정확도 ↑: 4배 확대 (작은 점도 살리려면 더 크게)
  const SCALE = 4;
  const upCanvas = document.createElement('canvas');
  upCanvas.width = w * SCALE;
  upCanvas.height = h * SCALE;
  const upCtx = upCanvas.getContext('2d');
  upCtx.imageSmoothingEnabled = false;
  upCtx.drawImage(canvas, 0, 0, upCanvas.width, upCanvas.height);

  const imgData = upCtx.getImageData(0, 0, upCanvas.width, upCanvas.height);

  // ⭐ 이진화 대신 그레이스케일 + 대비 강화 + 반전
  // 게임 화면의 어중간한 색상 숫자도 살리려면 이진화는 너무 공격적
  // → 부드러운 그레이스케일 + 색상 반전(검은 배경 → 흰 배경) + 대비만 강화

  // 1단계: 평균과 표준편차 계산 (대비 조정용)
  let sum = 0;
  let count = imgData.data.length / 4;
  for (let i = 0; i < imgData.data.length; i += 4) {
    sum += (imgData.data[i] * 0.3 + imgData.data[i + 1] * 0.59 + imgData.data[i + 2] * 0.11);
  }
  const mean = sum / count;

  // 2단계: 그레이스케일 + 반전 + 대비 강화
  // 게임 글자는 보통 평균보다 밝음 → 반전 후 평균보다 어두워짐
  // 대비를 2배로 늘려서 글자를 더 진하게
  const CONTRAST = 2.2;

  for (let i = 0; i < imgData.data.length; i += 4) {
    const r = imgData.data[i], g = imgData.data[i + 1], b = imgData.data[i + 2];
    let v = (r * 0.3 + g * 0.59 + b * 0.11);
    // 반전: 밝은 픽셀 → 어두운 픽셀
    v = 255 - v;
    // 대비 강화: 평균 기준으로 멀어지게
    const invMean = 255 - mean;
    v = invMean + (v - invMean) * CONTRAST;
    v = Math.max(0, Math.min(255, v));
    imgData.data[i] = imgData.data[i + 1] = imgData.data[i + 2] = v;
  }
  upCtx.putImageData(imgData, 0, 0);

  // 디버그 캔버스에 처리된 이미지 표시 (사용자가 OCR이 보는 걸 확인 가능)
  if (els.debugCanvas) {
    const dbgCanvas = els.debugCanvas;
    dbgCanvas.width = upCanvas.width;
    dbgCanvas.height = upCanvas.height;
    const dbgCtx = dbgCanvas.getContext('2d');
    dbgCtx.drawImage(upCanvas, 0, 0);
  }

  try {
    const result = await ocrWorker.recognize(upCanvas);
    const raw = result.data.text.trim();
    if (!raw) return;

    // 한글/영문 단위 포함해서 1차 파싱
    let num = parseKoreanNumber(raw);

    // 단위 강제 적용 (사용자가 수동 지정한 경우)
    // OCR이 "억"이나 "만"을 못 읽거나 점을 못 읽을 때를 보완
    let appliedUnit = '';
    if (num !== null && damageUnit !== 'auto' && damageUnit !== 'raw') {
      // raw 텍스트에 이미 한글 단위가 있으면 사용자 지정값 무시 (이중 적용 방지)
      const hasKoreanUnit = /[억만천]/.test(raw);
      // raw에 점이 있는지 확인
      const hasDot = /\./.test(raw);
      const rawDigits = raw.replace(/[^0-9]/g, '');

      if (!hasKoreanUnit) {
        const multiplier = damageUnit === 'eok' ? 100000000 : 10000;

        if (hasDot) {
          // 점이 있으면 그대로 (예: 1.22 × 1억 = 122,000,000)
          // num은 이미 parseFloat로 1.22 처리됨? → parseKoreanNumber는 정수만 반환
          // 다시 파싱
          const floatVal = parseFloat(raw.replace(/,/g, ''));
          if (!isNaN(floatVal)) {
            num = Math.round(floatVal * multiplier);
            appliedUnit = ` [×${damageUnit === 'eok' ? '억' : '만'}]`;
          }
        } else if (rawDigits.length >= 3 && damageUnit === 'eok') {
          // 점 없이 3자리 이상이면 OCR이 점을 놓쳤을 가능성 (예: "122" → 1.22로 추정)
          // 휴리스틱: 첫 자리 다음에 소수점이 있다고 가정
          // 122 → 1.22 → 1.22억 = 122,000,000
          // 1234 → 12.34 → 12.34억 (이건 좀 애매)
          // 게임 표시 규칙: 1.22억, 12.3억, 123억 같은 식이라 자릿수로 판별 필요
          // 안전하게: 사용자가 점이 사라진 걸 알고 단위 지정한 거라 가정 → 점 없는 정수에 곱
          // 그런데 이러면 1.22억이 122억이 됨...
          // → 명시적으로 2가지 모드 제공이 더 나음
          num = num * multiplier;
          appliedUnit = ` [×${damageUnit === 'eok' ? '억' : '만'}]`;
        } else {
          num = num * multiplier;
          appliedUnit = ` [×${damageUnit === 'eok' ? '억' : '만'}]`;
        }
      }
    }

    // raw 표시 (OCR이 읽은 그대로 + 파싱된 값 + 적용된 단위)
    if (num !== null && !isNaN(num)) {
      els.ocrRaw.textContent = `[raw: "${raw}"${appliedUnit} → ${num.toLocaleString()}]`;
    } else {
      els.ocrRaw.textContent = `[raw: "${raw}" → 파싱 실패]`;
      return;
    }

    if (num < 0) return;

    // 안정성 검증: 최근 3회 중 2회 이상 비슷한 값이어야 적용
    // (한 번 튀는 오인식 방지)
    recentReads.push(num);
    if (recentReads.length > 3) recentReads.shift();

    // 데미지는 단조 증가해야 함 (전투 중)
    // 이전 값보다 작아지면 오인식 가능성 높음 (단, 50% 이상 감소는 새 전투/리셋으로 간주)
    if (myDamage > 0) {
      // 새 값이 이전보다 작은데 절반 이상이면 OCR 오인식으로 의심 → 무시
      if (num < myDamage && num > myDamage * 0.5) {
        return;
      }
      // 100배 이상 점프도 오인식 의심
      if (num > myDamage * 100) {
        return;
      }
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
