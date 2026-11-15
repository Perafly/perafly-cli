# Değişiklik günlüğü

Sürümleme anlamsaldır (README §8). `--json` biçimi, hata `code`'ları, çıkış kodları, ortam değişkenleri ve
`perafly.jsonc` şeması sözleşmedir; bunları bozan değişiklik ana sürüm ister ve aşağıda "Sözleşme" başlığında yazılır.
Faz 4 bitene dek `0.x`.

## 0.9.0 — yayımlanmadı (Faz 11)

### Komutlar

- `api <METHOD> <yol>`: açık API'ye ham istek, CLI'ın kimliği (takım anahtarı → klasörün hesapsız proje anahtarı →
  kimliksiz) ve API adresiyle. Yöntem `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. Yol `/v1/…` ya da `/…` (önüne `/v1`
  eklenir), sorgu yolun içinde; mutlak adres, `//`, `\`, `.`/`..` parçası, `#` ve boşluk istek atılmadan reddedilir
  (`validation_error`, çıkış 2), sonuç ayrıca aynı köken ve `/v1` altı için denetlenir. `--data <json>`, `--data @dosya`
  (yayının dışlama kuralları geçerli: `.env*`, anahtarlar, `.perafly/` gönderilmez; sembolik bağ izlenmez) ya da
  `--data -` (stdin); `GET` gövde almaz. `DELETE` etkileşimli kipte sorar, değilse açık `--yes` ister. Çıktı yanıt
  gövdesidir (`{ data }` zarfı yok): güzel biçimli JSON, `--json` ile tek satır, JSON değilse metin. 2xx dışı yanıtta
  stdout boş kalır, hata nesnesi stderr'e (sunucunun ek problem alanları `details`'te), çıkış kodu durumdan.
  `-i, --include` durum ve başlıkları stderr'e yazar (`set-cookie`, `authorization` değeri yazılmaz). Gövde, başlık ve
  hata karartılır.
- `inspect <adres>`: `GET /v1/lookup?url=` (`lookupUrl`): tür (canlı, sürüm, dal önizlemesi, özel alan adı, depolama
  dosyası), proje adı ve kimliği, canlı sürüm, adresin gösterdiği sürüm, dal. 404 → "is not a Perafly project (or
  version) this sign-in can see" (çıkış 20); 400 → "Not a Perafly address" (çıkış 2). `--json` sunucunun nesnesi.
- `docs <sorgu...>`: `GET /v1/docs/search` (`searchDocs`), kimlik gönderilmez. `--lang en|tr` (varsayılan sistem dili,
  yoksa en), `--limit 1–20`. Sonuç başlık, bağlam, adres, kısa alıntı; `--json` liste. 503 `docs_unavailable` anlaşılır
  iletiyle (çıkış 1).
- `doctor`: Node.js (≥ 22), CLI sürümü ve kurulum türü, API erişimi ve süresi (kimliksiz `GET /v1/plans`), profil ve
  takım, kimlik deposu (anahtar zinciri, düz dosya ve `0600` izni; geniş izin uyarıdır, depo onu okurken daraltır),
  girişin geçerliliği (`GET /v1/me`), proje bağı (`GET /v1/projects/{id}`), `perafly.jsonc`, Git'te Perafly itme adresi
  ve kimlik yardımcısı (yardımcının gösterdiği program var mı), ajan istemcilerinde MCP yapılandırması, becerinin bu
  sürümle aynılığı ve `perafly`'ın PATH'te olup olmadığı. Her satır OK / WARN / FAIL ve öneri; `--json`
  `{ ok, summary, checks }`. FAIL varsa rapordan sonra `doctor_check_failed` (çıkış 1). Bozuk `config.json` ya da
  `.perafly/project.json`'da da rapor yazılır. Anahtarın değeri hiçbir çıktıya yazılmaz.
- `publish --access private|public`: yeni takım projesinin ilk erişimi (gövdede `access`). Klasör bağlıysa, `--project`
  verildiyse ya da hesapsız yayında istek atılmadan `validation_error`. 403 `access_change_forbidden` kodu ve çıkış
  kodu (10) korunarak yol gösteren iletiyle (özel yayınla, erişimi Perafly'dan değiştir; `recovery: perafly publish
  --access private`).
- `agent`: `--session <ags_…>` (tarifi var olan oturuma ileti olarak gönderir ve izler; tarif yoksa izler), `--new`
  (yeni oturum; varsayılan davranış), `--detach` (`--no-wait` ile aynı; ikisi de kalır), tarif `-` ise stdin'den.
  `--session` ile `--new`, `--project` ya da `--budget` birlikte verilemez (bütçe kuralı değişmedi). `say --no-wait`
  artık önceki olayları okumadan gönderir.
- Düzeltme: `agent --project` ve `agent ls --project` genel `--project` bayrağıyla çakıştığı için Commander değeri üst
  komuta veriyordu ve oturum projesiz açılıyordu; artık ikisine de bakılır.
- Yerel MCP: `lookupUrl` (`projects.read`), `searchDocs` ve `listPlans` (her kimliğe açık) araç oldu; izinler
  barındırılan MCP'yle aynı (backend `app/mcp/hosted.ts`). Sunucu yönergesine adres ve belge araması satırı eklendi.
- `src/api/openapi.json` backend'in güncel belgesine eşitlendi (`lookupUrl`, `searchDocs`, `listPlans`,
  `PublishRequest.access`, yeni hata yanıtları). `listVersionFiles` komutsuz kalır (gerekçe güncellendi).

### Dağıtım

- Tek dosya ikililer (Node SEA; içinde resmî Node 24 ve bütün bağımlılıklar): `perafly-darwin-arm64`,
  `perafly-darwin-x64`, `perafly-linux-x64`, `perafly-linux-arm64`, `perafly-windows-x64.exe` ve `SHA256SUMS`.
  `npm run build:binary` (geçerli platform, `dist-bin/`), `npm run checksums`, `npm run homebrew:formula`. Geliştirme
  bağımlılığı: `postject` (Node'un SEA belgesindeki gömme aracı; kurulu Node 24'te `--build-sea` yok).
- İkilide işletim sisteminin anahtar zinciri yoktur: kimlik `~/.perafly/credentials/` altında `0600` dosyadadır
  (`login` çıktısında `store: "plaintext"`); `PERAFLY_CREDENTIAL_STORE=keyring` `credential_keyring_unavailable` verir.
  Kimlik deposunun mantığı değişmedi: paketteki `@napi-rs/keyring` yüklenince hata veren taslaktır ve deponun "modül
  yok" yolu çalışır. Taslak olmasaydı SEA dinamik `import()`'u çalışma klasöründen (ya da derleme makinesinin yolundan)
  çözer, ikili oradaki `node_modules`'tan yerel kod yükleyip kimliği ona verirdi; pakette yerleşik olmayan bir yükleme
  kalırsa derleme düşer.
- İkilide `process.argv[1]` mutlak yola çevrilir (`src/binary.ts`): SEA'da ham `argv[0]`'dır (`perafly`) ve
  `git remote`'un kurduğu kimlik yardımcısı onu çalışma klasörüne göre çözerdi (`<depo>/perafly`). Artık PATH'te bu
  ikiliye giden girdi (Homebrew'un sürümden bağımsız bağı) ya da ikilinin kendi yolu yazılır. npm paketinde değişiklik
  yok.
- `setup agent` ikilide beceriyi derlemede gömülen kopyadan yazar.
- Kurulum betikleri: `packaging/install.sh` (macOS, Linux; POSIX sh) ve `packaging/install.ps1` (Windows). SHA-256
  özeti uymazsa kurmaz, sudo istemez, kabuk dosyalarına dokunmaz. `PERAFLY_VERSION`, `PERAFLY_INSTALL_DIR`,
  `PERAFLY_DOWNLOAD_BASE` (https; http yalnız localhost), `PERAFLY_REPOSITORY`: yalnız kurulum betiklerinin değişkenleri,
  CLI okumaz.
- Homebrew formülü şablonu `packaging/homebrew/perafly.rb`; depo ve tap adı `packaging/release.json`'da.
- İş akışları: `.github/workflows/ci.yml` (push ve PR: Node 22 ve 24'te typecheck, test, build; linux-x64 ikili duman
  testi; shellcheck) ve `.github/workflows/release.yml` (`v*` etiketi ya da elle, varsayılan dry run; beş platform
  ikilisi, `SHA256SUMS`, formül, taslak GitHub Release; npm yalnız etikette ve `--provenance` ile, `NPM_TOKEN` yoksa ya
  da paket `private` ise atlanır). Hiçbir şey kendiliğinden yayımlanmaz.

### Sözleşme

- Bozan değişiklik yok: `--json` biçimi, var olan hata kodları, çıkış kodları, CLI ortam değişkenleri ve
  `perafly.jsonc` aynı. Eklenenler: CLI kodu `doctor_check_failed` (çıkış 1); `api` çıktısı tanım gereği zarfsızdır
  (yanıt gövdesinin kendisi).

## 0.8.0 — yayımlanmadı (Faz 10)

### Komutlar

- `git` (ve `git status`): GitHub bağlantısı (depo, kurulum hesabı) ya da "Not connected", üretim dalı, otomatik canlı
  ve önizleme yayını, itme adresi, son 5 derleme (durum, dal, kısa işleme, ileti, sürüm, dal adresi); onay bekleyen
  çatal derlemesi varsa onay komutu. `--json` `{ git, builds }`.
- `git remote [--name perafly]`: depoda (değilse `not_a_git_repository`) projenin itme adresini (`push.url`) uzak olarak
  ekler ya da günceller; `origin`'e dokunmaz (`--name origin` reddedilir). Kimlik yardımcısını yalnız itme adresinin
  kökü için depo yapılandırmasına yazar (`credential.<köken>.helper`: önce boş değer, sonra `!<perafly> git
  credential`); o adresteki genel yardımcılar sıfırlanır, anahtar adrese ve git yapılandırmasına yazılmaz. İtme komutunu
  üretim dalıyla yazar (`git push perafly HEAD:main`). `--json` `{ remote, url }`.
- `git credential get|store|erase`: Git'in kimlik yardımcısı protokolü. `get` yalnız yapılandırılmış API'nin ana
  bilgisayarı ve onun `git.` kardeşi (`api.perafly.com` → `git.perafly.com`, https) için stdout'a tam iki satır yazar
  (`username=perafly`, `password=<pfa_…>`; anahtar `PERAFLY_TOKEN` ya da kayıtlı girişten). Anahtar yoksa çıktı yok,
  çıkış 0. `store` ve `erase` bir şey yapmaz. `PERAFLY_DEBUG` anahtarı yazmaz.
- `git set [--production-branch] [--auto-production on|off] [--auto-previews on|off] [--repository sahip/ad
  [--installation <kimlik>]]` (`--installation` tamsayı, yalnız `--repository` ile; istekten önce denetlenir),
  `git disconnect` (onay ister), `git builds [--status]`, `git approve <gbd_…>` (çatalın kodunun projenin ortam
  değişkenleriyle derleneceği uyarısı; her kipte onay ister, ajan kipinde yalnız açık `--yes`), `branches`.
- `publish`: CI'da (GitHub Actions, GitLab CI, Bitbucket, CircleCI) dal ve işleme kendiliğinden, `--branch <dal>` ve
  `--commit <sha>` her yerde; gövdeye `git: { branch, commit, message?, author? }` eklenir (yalnız takım yayınında, dal
  biliniyorsa; yazar e-postası gönderilmez; ileti ve yazar ortamda yoksa çekilmiş depodaki işlemeden). Sürümün dal
  adresi tamamlama yanıtındaki `version.git.branchUrl`'den yazılır; null ise (canlı ve üretim dalı) hiçbir şey yazılmaz,
  yerelde kurulmaz.
- `skills/perafly` (ve Claude Code eklentisindeki kopyası): Git araçları; depo bağlamak ve çatal derlemesini onaylamak
  kullanıcının işidir.
- Yerel MCP'de `getProjectGit`, `listGitBuilds`, `listProjectBranches` (`projects.read`); `setProjectGit`,
  `disconnectProjectGit`, `approveGitBuild` araç değildir (barındırılan MCP ile aynı).

### Sözleşme

- `publish --target` artık varsayılan değer taşımaz: verilmezse yine `live` gönderilir, ama dal bilindiğinde (CI ya da
  `--branch`) gönderilmez ve sunucu projenin dal kuralını uygular. CI'da dal bilgisi olan bir takım projesinde önceden
  canlıya giden üretim dışı dal artık önizlemeye gider; eski davranış için `--target live`. Üretim dalı ayarlanmamışsa
  `main`'dir: ana dalı başka adlı (`master`, `trunk`) projede `perafly git set --production-branch <dal>`.
- `publish --json`: dal bilgisiyle yayında `data.version.git` (`{ trigger, branch, commit, pullRequest, branchUrl }`) ve
  sunucu dal adresi verdiyse `data.branchUrl` eklenir (yalnız varsa).
- Yeni kodlar: `not_a_git_repository` (çıkış 2), `git_not_found`, `git_command_failed` (çıkış 1). Sunucu kodları
  (`git_build_not_awaiting` çıkış 30, `git_repository_not_found` ve `git_build_not_found` çıkış 20,
  `github_not_configured`) aynen taşınır.

## 0.7.0 — yayımlanmadı (Faz 9)

### Komutlar

- `data collections [ls]`, `data collections show <ad>`, `data collections create|update <ad> --schema <dosya|->`
  (`{ fields, rules?, hook? }` ya da alan dizisi; dosyadaki başka anahtar gönderilmez), `data collections rm <ad>`
  (koleksiyonu ve kayıtlarını siler; onay ister).
- `data ls <koleksiyon>`: `--filter alan=değer` → `filter[alan]`, `--filter alan:op=değer` → `filter[alan][op]` (`eq`,
  `ne`, `gt`, `gte`, `lt`, `lte`, `in`; tekrarlanabilir), `--sort`, `--limit`, `--cursor`. `data get`, `data add` ve
  `data update` (kayıt JSON'u `--file <dosya|->` ya da stdin'den), `data rm` (onay ister), `data export` (`--format
  csv|json`; `--out` dosyası 0600, yoksa stdout; `--json` ile `--out` gerekir), `data hooks` (son kanca teslimleri).
- `data keys`: yayınlanabilir anahtar (`pfp_`, sır değil; `--json`'da görünür), gizli anahtar ve kanca sırrı var mı.
  `--create-secret` (var olanı değiştirirken onay ister; `pfk_` yalnız insan çıktısında bir kez; `--json` ve ajan
  kipinde istek atılmadan reddedilir), `--rotate-publishable` ve `--revoke-secret` (onay ister).
- `env ls`, `env set <AD> [--plain]` (değer stdin'den ya da yankısız sorudan; komut argümanından asla: fazladan argüman
  ve `AD=değer` ağa gitmeden düşer; boşluk korunur, borudan gelende yalnız sondaki satır sonu atılır), `env rm <AD>`
  (onay ister). Değişiklik sonraki sürümde geçerlidir.
- `storage ls [önek]` (`--limit` 1–1000), `storage put <dosya> <yol>` (iki istek: yükleme adresi, sonra baytlar; 32 MB üstü akışla),
  `storage get <yol> [dosya|-]`, `storage mv <kaynak> <hedef> [--overwrite]`, `storage rm <yol|klasör/>` (onay ister),
  `storage sync <klasör> <önek> [--dry-run]` (eksik ya da boyutu farklı dosyaları yükler, silmez). Yerel dosyada yayının
  dışlama kuralları geçerlidir; sembolik bağ izlenmez.
- `sftp ls`, `sftp add <etiket> (--key <dosya.pub> | --password) [--readonly] [--folder <klasör>] [--ip <cidr>]…
  [--expires <ISO tarih>]` (yalnız `.pub` okunur; parola yalnız insan çıktısında bir kez, `--password` `--json` ve ajan
  kipinde istek atılmadan reddedilir; sunucu adı ve port oluşturma yanıtından), `sftp rm <sfa_…|etiket>` (onay ister).
- `skills/perafly` (ve Claude Code eklentisindeki kopyası): veri, depolama, ortam değişkenleri ve SFTP; ajanın yapamadığı
  işler kullanıcıya bırakılır.
- Yerel MCP'de veri ve depolama araçları (`listCollections`, `getCollection`, `createCollection`, `updateCollection`,
  `listRecords`, `getRecord`, `createRecord`, `updateRecord`, `deleteRecord`, `getDataKeys`, `listHookDeliveries`,
  `listEnvVars`, `listStorage`, `getStorageFile`, `moveStorage`, `deleteStorage`, `listSftpAccounts`); anahtar üretimi,
  ortam değişkeni yazma, SFTP hesabı, koleksiyon silme, dışa aktarma ve dosya baytı araç değildir (barındırılan MCP ile
  aynı). Kayıt gövdesi `body` nesnesi, `filter` nesnesi `filter[alan][op]` olarak gider.

### Sözleşme

- 402 plan hatalarında (`plan_limit_collections`, `plan_limit_records`, `plan_limit_storage`,
  `plan_limit_storage_file`, `plan_limit_sftp_accounts`, `plan_feature_unavailable`) sunucu `detail` vermediyse ileti
  sınırı ve önerilen planı söyler; hata nesnesinin `details`'ine `feature`, `used`, `upgradeTo` eklenir (çıkış 30).
- Yeni kod: `sftp_account_not_found` (çıkış 20).
- Bir kez gösterilen sır (`data keys --create-secret`, `sftp add --password`) `--json` ve ajan kipinde
  `validation_error` (çıkış 2) ile istek atılmadan reddedilir (`api-keys create` gibi).
- Argümanda sır denetimi genişledi: `pfa_`, `pfc_`, `pfs_`, `pfk_`, `pfw_`, `pfo_`, `pfr_`, `pfl_`, `pfh_` belirteci
  taşıyan argüman komut çalışmadan `validation_error` (çıkış 2) verir; yayınlanabilir anahtar (`pfp_`) sır değildir.

## 0.6.0 — yayımlanmadı (Faz 8)

### Komutlar

- `share`: erişim durumu (mod, bağlantı, parola, kişiler, bekleyen istekler). `share public` (onay ister; ajan kipi
  `--yes` sayılmaz), `share private`, `share link` (bağlantı yalnız insan çıktısında bir kez görünür; `--json`'da
  karartılır) ve `--revoke`, `share password` (stdin'den) ve `--clear`, `share add|rm <e-posta>`.
- `domains ls|add|check|rm`: özel alan adları; ekleyince kurulacak DNS kaydı ve gerekirse sahiplik TXT kaydı. `rm` onay
  ister.
- Yerel MCP'de `getProjectAccess` ve `listProjectDomains` araçları; erişim ve alan adı değiştiren işlemler araç değildir.

### Sözleşme

- Karartma `pfl_` (paylaşım bağlantısı) belirtecini de kapsar.

## 0.5.0 — yayımlanmadı (Faz 7)

### Komutlar

- `logs [access|runtime|build]`: projenin logları eskiden yeniye (`--level`, `--since 15m|2h|3d|ISO`, `--search`,
  `--version`, `--limit`); `-f, --follow` yeni satırları izler (`--follow-timeout`). `logs build` alt komutu değişmedi.
- `metrics`: trafik (istek, sayfa görüntüleme, ziyaretçi, bant genişliği, durumlar, önbellek, yollar, yönlendirenler)
  ve fonksiyon ölçümleri (çağrı, hata, süre yüzdelikleri, CPU, bellek); `--range 1h|24h|7d|30d`. Kod çalıştırmayan
  proje söylenir, ölçülmeyen değer "—".
- `top`: takımın projeleri trafiğe göre; `--watch`, `--interval`, `--count`.
- Yalnız takım anahtarıyla; hesapsız proje ölçülmez. Yerel MCP'de `listProjectLogs` (`logs.read`),
  `getProjectMetrics` ve `listProjectMetrics` (`usage.read`) araçları.

### Sözleşme

- `--json` ile `logs --follow` ve `top --watch` NDJSON yazar: her satır `{ "data": … }`.

## 0.4.0 — yayımlanmadı (Faz 6)

### Komutlar

- `agent "<tarif>"`: Perafly'ın yerleşik ajanını başlatır (`--project`, `--budget` dolar, `--no-wait`,
  `--wait-timeout`), ilerlemeyi izler, önizleme adresini ve canlıya alma yolunu yazar. Ajan canlıya alamaz.
- `agent ls`, `agent attach <ags>`, `agent say <ags> "<ileti>"`, `agent stop <ags>`, `agent budget <ags> <dolar>`,
  `agent allow|deny <ags> <olay>` (`deny --message`).
- Yalnız tam profilli girişle: ajan profili 403 (ajan kredisini başka bir ajan harcamaz). Yerel MCP'de ajan uçları araç
  değildir.

## 0.3.0 — yayımlanmadı (Faz 5)

### Komutlar

- `usage`: dönemin planı, kullanımı (ölçer satırlarıyla), aşımı, harcama sınırı, ajan kredisi ve yeni derlemelerin durup
  durmadığı. Yalnız okur; plan ve satın alma paneldedir. Yerel MCP'de `getUsage` aracı (`usage.read`).

### Sözleşme

- Yeni kodlar (HTTP 402, çıkış 30): `plan_limit_projects` (`limit`, `used`, `upgradeTo`, `readOnly`),
  `included_usage_exhausted`, `spend_limit_reached` (`periodEnd`). Sürüm boyutu aşımında (413) `upgradeTo`.

## 0.2.0 — yayımlanmadı (Faz 4)

### Komutlar

- Onaylar: ajan profilli girişte `publish` (canlının üzerine), `promote` ve `rollback` bir takım arkadaşının onayını
  bekler (`--wait`, varsayılan); `--no-wait` `approval_required` (çıkış 2) ve `recovery: perafly operations resume exe_…`
  verir. `operations resume <exe_…>` kararı bekler ve sonucu yazar. Ret `approval_declined` (çıkış 10), süre dolumu
  `approval_expired` (çıkış 20).
- `login --handoff`: devir bağlantısı stdin'den; projeye bağlı ajan anahtarı bu klasörün `.perafly/state.json`'una
  (0600) yazılır, klasör projeye bağlanır.
- `api-keys ls|create|revoke` (yalnız tam profil). Sır etkileşimli terminalde bir kez gösterilir, değilse yalnız
  `--out` dosyasına (0600) yazılır; `--json`'da yoktur.
- `mcp` (yerel MCP, stdio; `--workspace-root`), `mcp proxy` (barındırılan MCP'ye köprü; `--endpoint`), `mcp install`,
  `setup agent` (`--agent claude-code|cursor|codex|auto|all`, `--local|--remote|--oauth`, `--scope`, `--skip-mcp`,
  `--skip-skill`, `--force`, `--dry-run`).
- `skills/perafly/SKILL.md` ve `plugins/claude-code`, `plugins/cursor`, `plugins/codex` pakete girer.

### Sözleşme

- Yeni kodlar: `approval_required`, `approval_pending`, `approval_declined`, `approval_expired`, `path_outside_workspace`.
- Yeni ortam değişkenleri: `PERAFLY_MCP_URL`, `PERAFLY_MCP_WORKSPACE_ROOT`.
- MCP araç adları OpenAPI işlem adlarıdır; ek araçlar `publish`, `operation_status`, `resume_execution`.

## 0.1.0 — yayımlanmadı (Faz 3)

İlk sürüm. npm'e henüz yayımlanmadı (DEVELOPMENT_STEPS 3.9 kullanıcı onayı bekler).

### Komutlar

- Kimlik: `login` (RFC 8628 cihaz akışı, `--access full|agent|read`, `--token-stdin`, `--no-browser`), `logout`,
  `whoami`, `teams ls`, `profiles`, `switch`.
- Klasör: `init` (`--create`), `link`, `unlink`, `status` (çıplak `perafly`), `open` (`--version`).
- Yayın: `publish [DIR]` — klasör, tek HTML dosyası, `.zip` / `.tar.gz`; `--name`, `-m`, `--target live|preview`,
  `--publish-mode snapshot|additive`, `--prebuilt`, `--dry-run`, `--no-wait`, `--wait-timeout`. Hesapsız yayın:
  proje anahtarı yüklemeden önce `.perafly/state.json`'a (0600, `.gitignore`'a eklenir) yazılır.
- Sürümler ve projeler: `versions ls|get|rm`, `promote`, `rollback`, `operations get|wait`,
  `projects ls|get|create|update|rm|claim` (`--keep-publishing`), `logs build`.

### Sözleşme

- `--json`: başarı stdout'ta `{ "data": … }` (liste `{ data, pagination }`), hata stderr'de `{ "error": { code, message,
  status, type, title, retryable, recovery, requestId, suggestions, pointer } }`; anahtar, imzalı adres, cihaz kodu ve
  sahiplenme bağlantısı karartılır. `publish --json` `data.claim`'i anahtarsız verir (`expiresAt`, `claimDeadline`,
  `command`).
- Çıkış kodları: 0, 1, 2 (doğrulama, onay eksik), 10 (kimlik, 401/403), 20 (404/410), 30 (409/402), 40 (ağ, 429),
  50 (bekleme süresi), 130 (iptal).
- CLI'ın kendi kodları: `auth_required`, `credential_expired`, `credential_keyring_unavailable`,
  `confirmation_required`, `no_project_selected`, `no_team_selected`, `validation_error`, `handoff_link_in_argv`,
  `network_error`, `wait_timeout`, `invalid_response`, `state_write_failed`, `cancelled`.
- Ortam değişkenleri: `PERAFLY_TOKEN`, `PERAFLY_CLAIM_TOKEN`, `PERAFLY_API_URL`, `PERAFLY_PROJECT`, `PERAFLY_PROFILE`,
  `PERAFLY_YES`, `PERAFLY_AGENT`, `PERAFLY_AGENT_ALLOW_DESTRUCTIVE`, `PERAFLY_NON_INTERACTIVE`, `PERAFLY_HOME`,
  `PERAFLY_CREDENTIAL_STORE`, `PERAFLY_DEBUG`, `CI`, `NO_COLOR`, `FORCE_COLOR`.
- `perafly.jsonc` şeması: `$schema`, `build`, `redirects`, `rewrites`, `headers`, `crons`, `access`.
- `--version` yalnız tek başına verildiğinde sürümü yazar; alt komutlarda `--version <sürüm>` sürüm seçer.
