export default async function handler(req, res) {
    const { code } = req.query;

    if (!code) {
        return res.status(400).send('인증 코드가 누락되었습니다.');
    }

    // 환경 변수 검증
    const clientId = process.env.DISCORD_CLIENT_ID;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    const redirectUri = process.env.NEXT_PUBLIC_REDIRECT_URI;

    try {
        // 1. 디스코드 토큰 요청
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
        if (!tokenResponse.ok) throw new Error(tokenData.error_description || '토큰 취득 실패');

        // 2. 토큰으로 유저 정보 요청
        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });

        const userData = await userResponse.json();

        // 3. 유저 정보를 쿼리 스트링에 담아 프론트엔드 예약 페이지로 리다이렉트
        // 안전하게 인코딩하여 프론트엔드로 돌려보냅니다.
        const params = new URLSearchParams({
            status: 'success',
            discordId: userData.id,
            discordName: `${userData.username}${userData.discriminator !== '0' ? `#${userData.discriminator}` : ''}`,
            avatar: userData.avatar ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png` : 'https://cdn.discordapp.com/embed/avatars/0.png'
        });

        return res.redirect(`/?${params.toString()}`);
    } catch (error) {
        console.error('디스코드 인증 에러:', error);
        return res.redirect('/?status=error');
    }
}
