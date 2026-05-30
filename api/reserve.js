// Next.js API Route: /pages/api/reserve.js

// 서버 메모리 수준에서 작동하는 IP 기반의 도배 방지 캐시 (5초 딜레이)
const rateLimitCache = new Map();

export default async function handler(req, res) {
    // ------------------------------------------------------------------------
    // [기능 1] 디스코드 OAuth2 로그인 성공 시 처리하는 Callback 로직 (GET 방식)
    // ------------------------------------------------------------------------
    if (req.method === 'GET' && req.query.action === 'callback') {
        const { code } = req.query;

        if (!code) {
            return res.status(400).send('인증을 완료하기 위한 Code 값이 누락되었습니다.');
        }

        const clientId = process.env.DISCORD_CLIENT_ID;
        const clientSecret = process.env.DISCORD_CLIENT_SECRET;
        
        // 현재 호스트 도메인을 기준으로 리다이렉트 URI 동적 생성
        const host = req.headers.host;
        const protocol = host.startsWith('localhost') ? 'http' : 'https';
        const redirectUri = `${protocol}://${host}/api/reserve?action=callback`;

        try {
            // 1. 디스코드 인증 토큰 획득 API 호출
            const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
                method: 'POST',
                body: new URLSearchParams({
                    client_id: clientId,
                    client_secret: clientSecret,
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: redirectUri,
                }),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            });

            const tokenData = await tokenResponse.json();
            if (!tokenResponse.ok) {
                throw new Error(tokenData.error_description || '디스코드 토큰 발급에 실패했습니다.');
            }

            // 2. 획득한 액세스 토큰으로 디스코드 사용자 프로필 정보 조회
            const userResponse = await fetch('https://discord.com/api/users/@me', {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
            });

            const userData = await userResponse.json();
            if (!userResponse.ok) {
                throw new Error('사용자 프로필 데이터 취득 실패');
            }

            // 유저 닉네임 정제 (신규 유저명 방식 및 구식 태그 구분 처리)
            const discordName = userData.discriminator !== '0' 
                ? `${userData.username}#${userData.discriminator}` 
                : userData.username;

            // 프로필 아바타 이미지 주소 파싱 (아바타가 없을 시 기본 아바타 노출)
            const avatarUrl = userData.avatar 
                ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png` 
                : 'https://cdn.discordapp.com/embed/avatars/0.png';

            // 3. 쿼리 스트링에 식별값을 얹어 메인 예약 페이지로 리디렉트
            const redirectParams = new URLSearchParams({
                status: 'success',
                discordId: userData.id,
                discordName: discordName,
                avatar: avatarUrl
            });

            return res.redirect(`/?${redirectParams.toString()}`);

        } catch (error) {
            console.error('디스코드 인증 연동 프로세스 장애:', error);
            return res.redirect('/?status=error');
        }
    }

    // ------------------------------------------------------------------------
    // [기능 2] 디스코드 인증 완료 후 예약 내용을 최종 제출하는 로직 (POST 방식)
    // ------------------------------------------------------------------------
    if (req.method === 'POST') {
        const { date, inGameName, discordId, discordName, gameType } = req.body;

        // 1. 디바운싱 및 도배 제한 (5초 제한 보안 가드)
        let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'IP_UNKNOWN';
        if (clientIp && clientIp.includes(',')) {
            clientIp = clientIp.split(',')[0].trim();
        }

        const currentTime = Date.now();
        const lastSentTime = rateLimitCache.get(clientIp);

        if (lastSentTime && (currentTime - lastSentTime < 5000)) {
            console.log(`[도배방지 차단] IP: ${clientIp}`);
            return res.status(429).json({ message: '너무 빠르게 연속 요청하셨습니다. 5초 뒤 다시 시도해 주세요.' });
        }
        
        // 최신 요청 시간 업데이트
        rateLimitCache.set(clientIp, currentTime);

        // 2. IP 블랙리스트 우회 탐지
        const bannedIpsString = process.env.BANNED_IPS || ""; 
        const bannedIps = bannedIpsString.split(',').map(ip => ip.trim());

        if (bannedIps.includes(clientIp)) {
            console.log(`[블랙리스트 차단] 차단 IP 접촉: ${clientIp}`);
            return res.status(403).json({ message: '허용되지 않은 사용자 환경 또는 차단 상태입니다.' });
        }

        // 3. 필수 인자값 확인
        if (!date || !inGameName || !discordId || !discordName || !gameType) {
            return res.status(400).json({ message: '필수 입력 정보가 누락되었거나 비정상적인 디스코드 접근입니다.' });
        }

        const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
        const targetRoleId = process.env.DISCORD_ROLE_ID;

        if (!webhookUrl) {
            return res.status(500).json({ message: '서버 환경 변수가 세팅되지 않았습니다. 관리자에게 문의하세요.' });
        }

        // 4. 전송할 디스코드 예약 임베드/메시지 제작
        // <@discordId> 문법을 사용하여, 예약자를 디스코드에서 바로 멘션/클릭하여 DM을 보낼 수 있게 매핑합니다.
        const discordMessage = {
            content: `<@&${targetRoleId}> 새로운 예약 신청이 도착했습니다! 🎉`,
            embeds: [
                {
                    title: "📸 사진관 예약 신청서",
                    color: 2829601, // 연한 다크 카키 혹은 차콜 계열 컬러 테마 지정
                    fields: [
                        { name: "🎮 게임 종류", value: gameType, inline: true },
                        { name: "📅 예약 희망일", value: date, inline: true },
                        { name: "👤 인게임 닉네임", value: inGameName, inline: false },
                        { name: "💬 신청자 (디스코드)", value: `<@${discordId}> (${discordName})`, inline: false },
                        { name: "🌐 접속 주소", value: `||${clientIp}||`, inline: false }
                    ],
                    timestamp: new Date().toISOString(),
                    footer: { text: "마인크래프트 사진관 예약 봇 시스템" }
                }
            ]
        };

        // 5. 디스코드 전용 웹훅 채널로 전송
        try {
            const discordResponse = await fetch(webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(discordMessage)
            });

            if (discordResponse.ok) {
                return res.status(200).json({ message: '성공' });
            } else {
                const errorLog = await discordResponse.text();
                console.error("디스코드 연동 전송 피드백 에러:", errorLog);
                return res.status(500).json({ message: '디스코드 서버로 예약을 전송하지 못했습니다.' });
            }
        } catch (error) {
            console.error("서버 내부 전송 프로세스 에러:", error);
            return res.status(500).json({ message: '서버 내부 에러 발생' });
        }
    }

    // GET(Callback) 및 POST(예약 등록)을 제외한 모든 메서드 거부
    return res.status(405).json({ message: '허용되지 않은 API 엔드포인트 호출 규격입니다.' });
}
