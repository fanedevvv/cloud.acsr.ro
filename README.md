# cloud.acsr.ro

Galerie privată de poze și clipuri, self-hosted (stil Google Photos). Un singur
utilizator, protejată cu parolă. Fișierele sunt stocate **în afara webroot-ului**
și servite doar după autentificare.

## Ce face

- Grilă de miniaturi grupată pe zi, ordine cronologică (data EXIF dacă există)
- Încărcare multiplă: buton sau drag & drop pe toată pagina, cu bară de progres
- Vizualizare full-screen (lightbox) cu navigare ← →, video cu streaming (Range)
- Ștergere din lightbox
- Miniaturi generate cu `sharp`; poster de video dacă `ffmpeg` e instalat

## Instalare

```bash
npm install
npm run set-password -- PAROLA_TA        # scrie .env (hash bcrypt + secret sesiune)
npm start                                # ascultă pe 127.0.0.1:4300
```

Editează `.env` pentru `PORT`, `MAX_UPLOAD_MB` etc. (vezi `.env.example`).
Pune `COOKIE_SECURE=true` când rulează în spatele HTTPS.

### Schimbarea parolei

```bash
npm run set-password -- PAROLA_NOUA
```

## Producție

### Reverse proxy (nginx)

```nginx
server {
    listen 443 ssl;
    server_name cloud.acsr.ro;

    # certificatele tale ssl_certificate / ssl_certificate_key

    client_max_body_size 2200M;      # >= MAX_UPLOAD_MB
    proxy_read_timeout 600s;
    proxy_request_buffering off;     # streaming upload, nu buffer pe disc în nginx

    location / {
        proxy_pass http://127.0.0.1:4300;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Cu HTTPS activ, setează `COOKIE_SECURE=true` în `.env`.

### Serviciu (systemd)

```ini
# /etc/systemd/system/cloud-acsr.service
[Unit]
Description=cloud.acsr.ro gallery
After=network.target

[Service]
WorkingDirectory=/var/www/cloud.acsr.ro
ExecStart=/usr/bin/node server.js
Restart=on-failure
Environment=NODE_ENV=production
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now cloud-acsr
```

(Sau via pm2, ca celelalte site-uri de pe server:
`pm2 start server.js --name cloud-acsr`)

## Model de securitate

| Zonă | Măsură |
|---|---|
| Acces | O singură parolă, hash **bcrypt** (cost 12); nimic public |
| Sesiuni | Cookie `httpOnly`, `sameSite=lax`, `secure` opțional; stocate în SQLite; ID regenerat la login |
| Brute force | Rate limit 10 încercări / 15 min / IP pe `/api/login` |
| CSRF | Token per-sesiune în antet `X-CSRF-Token` (double-submit) + verificare `Origin` la scriere |
| Fișiere | Stocate în `data/originals` (în afara webroot); nume = UUID generat, fără input de la user → fără path traversal |
| Servire | `/media/:id/*` cere sesiune validă; `:id` validat ca UUID |
| Tipuri | Allowlist de MIME/extensii (imagine/video); imaginile sunt re-procesate cu `sharp` |
| Anteturi | `helmet` — CSP restrictiv (`default-src 'self'`, fără scripturi inline), `nosniff`, `X-Frame-Options`, HSTS |
| Erori | Fără stack trace către client |

### Ce NU acoperă (decizii conștiente)

- Fără versionare / coș de gunoi — ștergerea e definitivă
- Fără scanare antivirus a fișierelor încărcate
- Fără 2FA (un singur user, o parolă)
- Backup-ul folderului `data/` rămâne în sarcina ta

## Structură

```
server.js            Express: auth, API, servire fișiere
lib/env.js           încărcător .env (fără dependințe)
lib/db.js            schema SQLite (better-sqlite3)
lib/media.js         procesare upload: thumbnails, EXIF, ffmpeg
tools/set-password.js  generează .env
public/              frontend static (login + galerie)
data/                DB + fișiere (gitignored, creat la runtime)
```
