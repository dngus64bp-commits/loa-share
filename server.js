// LOA-SHARE 서버
// 같은 공대 ID로 접속한 유저들끼리 데미지 데이터를 중계해줍니다.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }, // 개발용. 배포 시 도메인 제한 권장
});

// 정적 파일(웹페이지) 서빙
app.use(express.static(path.join(__dirname, 'public')));

// 공대별 멤버 상태 저장 (메모리)
// { "공대ID": { socketId: { nickname, damage, updatedAt } } }
const raids = {};

io.on('connection', (socket) => {
  console.log('[연결]', socket.id);

  // 공대 입장
  socket.on('join', ({ raidId, nickname }) => {
    if (!raidId || !nickname) return;

    socket.data.raidId = raidId;
    socket.data.nickname = nickname;
    socket.join(raidId);

    if (!raids[raidId]) raids[raidId] = {};
    raids[raidId][socket.id] = {
      nickname,
      damage: 0,
      updatedAt: Date.now(),
    };

    console.log(`[입장] ${nickname} → 공대 ${raidId}`);

    // 본인에게 현재 공대 상태 전송
    socket.emit('roster', raids[raidId]);
    // 다른 공대원들에게 새 멤버 알림
    socket.to(raidId).emit('member-joined', { socketId: socket.id, ...raids[raidId][socket.id] });
  });

  // 데미지 업데이트
  socket.on('damage-update', ({ damage }) => {
    const raidId = socket.data.raidId;
    if (!raidId || !raids[raidId] || !raids[raidId][socket.id]) return;

    raids[raidId][socket.id].damage = damage;
    raids[raidId][socket.id].updatedAt = Date.now();

    // 같은 공대원들에게 브로드캐스트
    io.to(raidId).emit('damage-update', {
      socketId: socket.id,
      nickname: raids[raidId][socket.id].nickname,
      damage,
    });
  });

  // 디스코드 웹훅 전송
  socket.on('send-to-discord', async ({ webhookUrl }) => {
    const raidId = socket.data.raidId;
    if (!raidId || !raids[raidId]) {
      socket.emit('discord-result', { ok: false, error: '공대 정보 없음' });
      return;
    }
    if (!webhookUrl || !webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
      socket.emit('discord-result', { ok: false, error: '잘못된 웹훅 URL' });
      return;
    }

    const members = Object.values(raids[raidId])
      .sort((a, b) => b.damage - a.damage);
    const total = members.reduce((s, m) => s + m.damage, 0);

    const lines = members.map((m, i) => {
      const pct = total > 0 ? ((m.damage / total) * 100).toFixed(1) : '0.0';
      const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
      return `${medal} **${m.nickname}** — ${m.damage.toLocaleString()} (${pct}%)`;
    });

    const embed = {
      title: `🗡️ 레이드 결과 — 공대 ${raidId}`,
      description: lines.join('\n'),
      color: 0xc9a96e,
      footer: { text: `총 피해량 ${total.toLocaleString()} · LOA-SHARE` },
      timestamp: new Date().toISOString(),
    };

    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      });
      if (res.ok) {
        socket.emit('discord-result', { ok: true });
      } else {
        const txt = await res.text();
        socket.emit('discord-result', { ok: false, error: `${res.status}: ${txt}` });
      }
    } catch (e) {
      socket.emit('discord-result', { ok: false, error: e.message });
    }
  });

  // 연결 해제
  socket.on('disconnect', () => {
    const raidId = socket.data.raidId;
    if (raidId && raids[raidId] && raids[raidId][socket.id]) {
      const nickname = raids[raidId][socket.id].nickname;
      delete raids[raidId][socket.id];
      console.log(`[퇴장] ${nickname} ← 공대 ${raidId}`);

      io.to(raidId).emit('member-left', { socketId: socket.id });

      if (Object.keys(raids[raidId]).length === 0) {
        delete raids[raidId];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✨ LOA-SHARE 서버 실행 중 → http://localhost:${PORT}`);
});
