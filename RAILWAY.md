# Woontegra Lisans Server — Railway Kurulumu

## P3008 hatası (lokal)

`migrate resolve` zaten uygulanmış migration için tekrar çalıştırılırsa **P3008** verir. Bu hata değil; lokal DB hazır.

Lokal kontrol:
```powershell
npx prisma migrate deploy
# → No pending migrations to apply.
```

---

## Railway’e DB yükleme (5 adım)

### 1) Railway’de PostgreSQL oluştur

Railway projesi → **+ New** → **Database** → **PostgreSQL**

Postgres servisinde **Connect** → **Public Network** → **Database URL** kopyala.

Sonuna mutlaka ekle (yoksa):
```
?sslmode=require
```

Örnek:
```
postgresql://postgres:SIFRE@xxx.proxy.rlwy.net:12345/railway?sslmode=require
```

### 2) Migration dosyalarını GitHub’a push et

`prisma/migrations/` klasörü repoda olmalı. Lokal backend klasöründe:

```powershell
cd C:\Users\Woontegra\Desktop\Woontegra-Lisans-Server\backend
git add prisma/migrations .gitignore package.json RAILWAY.md
git commit -m "Add Prisma migrations and Railway deploy scripts"
git push origin main
```

### 3) Railway Backend servisi

**+ New** → **GitHub Repo** → `woontegra/Lisans-Server-Backend`

**Root Directory:** boş (repo kökü backend ise) veya Railway’de repo yapınıza göre `backend`

**Build Command:**
```
npm install && npm run build
```

**Start Command:**
```
npm start
```
(`start` = `prisma migrate deploy` → `npm run seed` → `node dist/index.js`)

Seed her deploy’da otomatik çalışır; admin ve programlar upsert ile idempotent güncellenir. Manuel PC seed gerekmez.

### 4) Railway Variables (Backend servisi)

| Değişken | Değer |
|----------|--------|
| `DATABASE_URL` | Postgres servisinden **Reference** ile bağla veya Public URL |
| `JWT_SECRET` | Güçlü rastgele string (min 32 karakter) |
| `ADMIN_EMAIL` | info@woontegra.com |
| `ADMIN_PASSWORD` | Railway’de güçlü şifre (repo’ya yazmayın) |
| `INTEGRATION_SECRET` | Website ile aynı olacak gizli anahtar |
| `PORT` | Railway otomatik verir; genelde tanımlamayın |
| `NODE_ENV` | production |

SMTP (isteğe bağlı): `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`

Deploy sonrası test:
```
https://lisans-server-backend-production.up.railway.app/health
```

### 5) Vercel Frontend (admin panel)

| Değişken | Değer |
|----------|--------|
| `VITE_API_URL` | `https://lisans-server-backend-production.up.railway.app` |

Login istekleri Vercel’e değil, Railway backend’e gider.

---

## Sık hatalar

| Hata | Çözüm |
|------|--------|
| `No migration found` | `prisma/migrations` GitHub’da yok → push edin |
| `P3005 schema not empty` | DB’ye daha önce `db push` yapılmış → `npx prisma migrate resolve --applied 20260619120000_init` sonra `migrate deploy` |
| `P3008 already applied` | Sorun yok, devam edin |
| Railway bağlanamıyor | URL’de `?sslmode=require` olsun; Public Network URL kullanın |
| Seed tekrar | `npm run seed` upsert yapar; güvenle tekrar çalıştırılabilir |

---

## Website bağlantısı

Website backend Variables:
```
LICENSE_SERVER_URL=https://SIZIN-LISANS-BACKEND.up.railway.app
LICENSE_SERVER_INTEGRATION_SECRET=<Lisans Server INTEGRATION_SECRET ile aynı>
```
