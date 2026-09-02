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

Live pe **https://cloud.acsr.ro** — Node pe `127.0.0.1:4300`, în spatele nginx,
cu `COOKIE_SECURE=true` în `.env`.

### Proces (pm2, ca restul site-urilor de pe server)

```bash
pm2 start server.js --name cloud-acsr --cwd /var/www/cloud.acsr.ro
pm2 save
```

Utilitare: `pm2 restart cloud-acsr`, `pm2 logs cloud-acsr`.

### Reverse proxy (nginx)

Vhost-ul folosit e versionat în [`deploy/nginx.conf`](deploy/nginx.conf) și
instalat la `/etc/nginx/sites-available/cloud.acsr.ro.conf`. Puncte cheie:
`client_max_body_size 2200m` (>= `MAX_UPLOAD_MB`), `proxy_request_buffering off`
și timeout-uri de 600s pentru upload-uri mari.

Certificat Let's Encrypt obținut cu:

```bash
certbot certonly --webroot -w /var/www/certbot -d cloud.acsr.ro
```

(reînnoire automată prin task-ul certbot deja configurat pe server)

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
