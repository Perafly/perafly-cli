# perafly-cli

**`perafly` komutu (kısa adı `pf`): bir klasörü canlı adrese çevirir, ajanları Perafly'a bağlar.**

> **Durum (15 Kasım 2026): Faz 3–11 komutları çalışıyor, npm'de henüz yayında değil (`0.9.0`).** Faz 3: `login`
> (cihaz akışı, `--token-stdin`), `logout`, `whoami`, `teams ls`, `profiles`, `switch`, `init`, `link`, `unlink`,
> `status`, `open`, `publish` (hesapsız yayın dahil), `versions`, `promote`, `rollback`, `operations get|wait`,
> `projects ls|get|create|update|rm|claim`, `logs build`. Faz 4: onay bekleme (`publish`, `promote`, `rollback`;
> `--no-wait` → `approval_required`), `operations resume`, `login --handoff`, `api-keys ls|create|revoke`, `mcp`
> (yerel MCP), `mcp proxy`, `mcp install`, `setup agent`, `skills/perafly`, `plugins/`. Faz 5: `usage`. Faz 6: `agent`, `agent ls|attach|say|stop|budget|allow|deny`. Faz 7: `logs [access|runtime|build]` (`--follow`), `metrics`, `top`. Faz 8: `share`, `share public|private|link|password|add|rm`, `domains ls|add|check|rm`. Faz 9: `data collections`,
> `data ls|get|add|update|rm|export|keys|hooks`, `env ls|set|rm`, `storage ls|put|get|mv|rm|sync`, `sftp ls|add|rm`. Faz 10:
> `git [status]`, `git remote`, `git credential`, `git set|disconnect|builds|approve`, `branches`, CI'da `publish`'in dal
> ve işleme algılaması (`--branch`, `--commit`). Faz 11: `api`, `inspect`, `docs`, `doctor` (§2.9),
> `publish --access`, `agent --session|--new|--detach`. Planlananlar (kodda yok): `projects transfer` (backend ucu yok),
> `publish --build-command` ve diğer `build` bayrakları, `skills status|remove` ve `plugins` komutları (beceri bugün
> `setup agent` ile kurulur). Kurulum:
> `npm install && npm run build`, sonra `node dist/cli.js`. Denetim: `npm run typecheck && npm test && npm run build`.

npm paketi `perafly`; Node + TypeScript. Açık API `https://api.perafly.com/v1` ile konuşur ve yerel MCP sunucusunu aynı
pakette taşır. Spacefast'in `sf` komutunun ([belgeler](https://spacefast.com/docs/cli/)) Perafly karşılığıdır; davranış
uyarlanır, metin kopyalanmaz. Bağlayıcı kaynak [`perafly-backend/README.md`](../perafly-backend/README.md)'dir (aşağıda
"backend"): kavramlar (takım, proje, sürüm, canlı kanal, önizleme, çalışma alanı, ajan oturumu, işlem, sahiplenme),
kimlikler, yayın akışı, izinler, açık API ve faz numaraları oradan gelir; çelişkide backend geçerlidir. Komut adları,
bayraklar ve CLI'a özgü davranışlar öneridir; Faz 3 başında OpenAPI işlem adlarıyla birlikte kesinleşir. Karara
bağlanmamış konular [Açık sorular](#açık-sorular) bölümündedir.

| Repo | Rol | Yayın |
| --- | --- | --- |
| `perafly-backend` | API, yayın hattı, barındırılan MCP, ajan oturumları; ortak belgeler | backend §14 karar 5 |
| `perafly-frontend` | Web: tanıtım sitesi, belgeler, panel, Drop, sahiplenme, admin | Vercel |
| `perafly-app` | Mobil: izleme ve yönetim uygulaması (Expo) | EAS, mağazalar |
| `perafly-cli` | Bu repo: `perafly` komutu, yerel MCP, `perafly.jsonc` şeması, ajan eklentileri ve becerisi | npm |

## 1. Hızlı başlangıç

```bash
npm install -g perafly        # komutlar: perafly ve pf (Homebrew ve ikililer sonra, §8)
perafly login                 # kod yazdırır, tarayıcıyı açar; onaylayınca API anahtarı (pfa_…) saklanır
perafly publish ./dist
```

Örnek çıktı (biçim öneridir; CLI çıktısı İngilizcedir):

```text
Published: https://my-site.perafly.app

  Live URL     https://my-site.perafly.app
  Version URL  https://my-site--v1.perafly.app
  Project      my-site (prj_…)
  Version      v1 (ready)
  Files        42 uploaded, 0 reused (3 ignored)
  Duration     9.8s
```

İlk yayın klasöre `.perafly/project.json` (projeye bağlantı, işlenir) yazar; sonraki yayınlar aynı projeyi günceller.

```bash
perafly publish ./dist -m "Fiyat tablosu"   # v2; yalnız değişen dosyalar yüklenir, gerisi yeniden kullanılır
perafly publish ./dist --target preview     # v3 önizleme: https://my-site--v3.perafly.app; live yerinde kalır
perafly versions ls
perafly promote v3                          # live → v3; hiçbir şey yeniden derlenmez
perafly rollback v2 --yes                   # live → v2; geri alma onay ister (§4.3)
perafly domains add example.com             # Faz 8: girilecek DNS kayıtlarını gösterir; `domains check` doğrulamayı izler
```

Bildirim canlı sürümle bayt bayt aynıysa sürüm oluşmaz; CLI `No changes` der (`noop_publish`). Özel alan adı canlı
sürümü sunar, `perafly.app` adresi çalışmaya devam eder.

### Hesapsız yayın ve sahiplenme

```bash
npx perafly publish ./dist          # giriş yok: sahipsiz bir proje açılır
perafly projects claim              # aynı klasörden; gerekirse girişi başlatır
```

Girişsiz `publish` yalnız statik çıktı içindir; derleme, fonksiyon ve yerleşik ajan hesap ister. Çatı kullanan proje
hesapsız yayınlanacaksa önce kendi makinende derlenir, çıktı klasörü yayınlanır. Sunucu proje
anahtarını (`pfc_…`) bir kez döner; CLI onu `.perafly/state.json`'a yazar, dosyayı `.gitignore`'a ekler ve anahtarı
ekrana yazmaz. Çıktıda canlı adres, sahiplenme bağlantısı (anahtar URL parçasında) ve bitiş zamanı bulunur; süre ve
sınırlar backend §3'tedir. `projects claim` projeyi bir takıma bağlar (`--team`): adresler değişmez, süre kalkar.
`--keep-publishing` yayınlayan ajana projeye bağlı bir API anahtarı verir.

## 2. Komut başvurusu

Faz sütunu backend §13'tür. Uzak işlem yapan her komut bir açık API işlemine karşılık gelir (§7). "Planlanan" satırlar
kodda yoktur; komut ya da bayrak verilirse CLI onu tanımaz.

| Komut | Ne yapar | Faz |
| --- | --- | --- |
| **Kimlik ve kurulum** | | |
| `login` | Cihaz akışı (`perafly.com/authorize`); `pfa_` anahtarı (30 gün, 7 gün kullanılmazsa düşer); `--access`, `--token-stdin`, `--handoff` | 3 |
| `logout` | Yerel kimliği siler, sunucuda iptal eder; elle oluşturulan API anahtarlarına dokunmaz | 3 |
| `whoami`, `teams ls` | Etkin kimlik ve üyelikler (`GET /v1/me`); üyelik değişikliği yalnız panelden (backend §8) | 3 |
| `init` | `perafly.jsonc` yazar (`$schema` ile); istenirse proje açar ve bağlar | 3 |
| `link [proje]`, `unlink` | Klasörü projeye bağlar (`.perafly/project.json`) ya da bağlantıyı kaldırır | 3 |
| `switch [takım]`, `profiles` | Varsayılan takım; adlandırılmış profiller (hesap, API adresi, takım) | 3 |
| `status`, `open` | Giriş, takım, bağlı proje, canlı sürüm, hesapsız proje bitişi (çıplak `perafly`); adresi açar | 3 |
| **Yayın, sürümler, projeler** | | |
| `publish [DIR]` | Klasörü, tek HTML dosyasını ya da arşivi yayınlar (§2.1); CI'da dalı ve işlemeyi kendisi gönderir (§2.6); `--access` yeni projenin ilk erişimi | 3; CI 10; `--access` 11 |
| `versions ls\|get\|rm` | Sürümleri listeler (numara, durum, adres), birini gösterir; `rm` canlı olmayan sürümü siler (`--yes`) | 3 |
| `promote <sürüm>`, `rollback <sürüm>` | `live`'ı hazır bir sürüme taşır; aynı işlem, `rollback` onay ister | 3 |
| `operations get\|wait <opr_…>` | Uzun işin durumunu gösterir ya da bitmesini bekler | 3 |
| `operations resume <exe_…>` | Onaylanan bekleyen çağrıyı sürdürür (`POST /v1/executions/{id}/resume`) | 4 |
| `projects ls\|get\|create\|update\|rm` | Projeler; `rm` `--yes` ister, ajan kimliğiyle yapılamaz (backend §4.3) | 3 |
| `projects claim` | Hesapsız projeyi takıma bağlar; `--team`, `--keep-publishing` | 3 |
| `projects transfer <takım>` | **Planlanan** (backend'de uç yok): projeyi başka takıma devreder (sahip ve yönetici; `--yes`) | planlanan |
| **Alan adları, paylaşım, yapılandırma** | | |
| `domains add\|check\|ls\|rm` | Özel alan adı ekler, kurulacak DNS kaydını ve durumunu gösterir, listeler, kaldırır (onaylı) | 8 (bitti) |
| `share`, `share public\|private\|link\|password\|add\|rm` | Erişim modu; bağlantı (bir kez gösterilir), parola (stdin), kişi ile paylaşım; istekler panelde ve mobilde onaylanır | 8 (bitti) |
| `env ls\|set\|rm` | Ortam değişkenleri (§2.8); değer stdin'den ya da yankısız sorudan, argümandan asla; `--plain` görünür değer; değişiklik sonraki sürümde; `rm` onaylı | 9 (bitti) |
| `data collections [ls]\|show\|create\|update\|rm` | Headless veri katmanı: koleksiyon şemaları (backend §5, API §20.1); şema dosyadan ya da stdin'den (`--schema`); `rm` kayıtlarla birlikte siler (onaylı) | 9 (bitti) |
| `data ls\|get\|add\|update\|rm\|export` | Kayıtlar (§2.8): `--filter alan=değer`, `--filter alan:op=değer`, `--sort`, sayfalama; kayıt JSON'u dosyadan ya da stdin'den; `export` CSV ya da JSON | 9 (bitti) |
| `data keys`, `data hooks` | Yayınlanabilir anahtar (sır değil), gizli anahtar (`--create-secret`, bir kez gösterilir), `--rotate-publishable`, `--revoke-secret`; son kanca teslimleri | 9 (bitti) |
| `storage ls\|put\|get\|mv\|rm\|sync` | Proje depolaması: yol adresli dosyalar (§2.7); `sync` eksik ya da boyutu farklı dosyaları yükler, silmez; `rm` onaylı | 9 (bitti) |
| **Gözlem** | | |
| `logs [access\|runtime\|build]` | Logları gösterir ve izler (§2.2); `logs build` barındırıcının derleme logu | `build` 3; diğerleri 7 |
| `metrics`, `top` | Projenin trafiği (istek, görüntüleme, ziyaretçi, yollar) ve çalışma ölçümleri (§2.3); `top` takımın projelerini sıralar | 7 |
| `usage` | Dönemin kullanımı: dahil kullanım, aşım, harcama sınırı | 5 |
| **Ajanlar** | | |
| `agent ["<tarif>"]` | Yerleşik ajan oturumunu başlatır (`--new`, varsayılan) ya da sürdürür (`--session <ags_…>`), olayları izler; `--detach` izlemez (§2.4) | 6; `--session`, `--new`, `--detach` 11 |
| `setup agent` | Ajan istemcilerini bulur, MCP yapılandırmasını yazar, beceriyi kurar (§2.5) | 4 |
| `mcp`, `mcp proxy`, `mcp install` | Yerel MCP, barındırılan sunucuya köprü, yalnız MCP yapılandırması (§2.5) | 4 |
| `skills [status\|remove]`, `plugins` | **Planlanan** (komut olarak yok). Bugün beceri `setup agent` ile kurulur (`--skip-mcp` yalnız beceri), kurulu becerinin bu sürümle aynı olup olmadığını `doctor` söyler; eklentiler `plugins/` klasöründe dosyadır (§6.3) | planlanan |
| **Anahtarlar, yardımcılar, Git** | | |
| `api-keys create\|ls\|revoke` | Anahtar bir kez gösterilir; ajan kimliğiyle üretilemez | 4 |
| `api <METHOD> <yol>` | Açık API'ye ham istek; kimlik ve API adresi CLI'dan gelir, mutlak adres reddedilir; `DELETE` onaylı (§2.9) | 11 (bitti) |
| `inspect <adres>` | Adresten projeyi ve sürümü bulur (`lookupUrl`): canlı, sürüm, dal önizlemesi, özel alan adı, depolama dosyası (§2.9) | 11 (bitti) |
| `docs <sorgu>` | Belgelerde arar (`searchDocs`); giriş gerekmez, kimlik gönderilmez; `--lang`, `--limit` (§2.9) | 11 (bitti) |
| `doctor` | Yerel kurulumu denetler: Node, API erişimi, giriş, kimlik deposu, proje bağı, `perafly.jsonc`, Git yardımcısı, ajan istemcileri; OK/WARN/FAIL (§2.9) | 11 (bitti) |
| `sftp ls\|add\|rm` | Proje depolamasının SFTP hesapları (§2.7); parola bir kez gösterilir; ajan kimliğiyle üretilemez; ücretli planlarda | 9 (bitti) |
| `git [status]`, `git set\|disconnect` | GitHub bağlantısı, üretim dalı, otomatik yayın, itme adresi ve son 5 derleme; depo bağlama ve dal ayarları; bağlantıyı kesme (onaylı) (§2.6) | 10 (bitti) |
| `git remote`, `git credential` | Projenin itme adresini depoya uzak olarak ekler (doğrudan itme, `origin`'e dokunmaz) ve Git'in kimlik yardımcısını yalnız o adres için kurar; anahtar adrese ve git yapılandırmasına yazılmaz | 10 (bitti) |
| `git builds`, `git approve <gbd_…>`, `branches` | Git derlemeleri; çataldan gelen çekme isteğinin derlemesini onaylar (onaylı; ajan kipinde yalnız açık `--yes`); dal adresleri | 10 (bitti) |

Bilerek olmayanlar: `perafly dev` yoktur (çatının kendi geliştirme sunucusu kullanılır). Spacefast'in kendi çalışma
zamanına bağlı komutlarının (Zero, Functions, `runtime`) karşılığı yoktur; derleme ve çalıştırma Vercel'dedir.

### 2.1 `publish`

Akış backend §3'tür: bildirim (yol, boyut, `sha256`) → yalnız eksik dosyalar yüklenir → derleme → `ready` → `live`
taşınır. **CLI derleme çalıştırmaz**: kaynağı Vercel algılar ve derler; `--prebuilt` hazır çıktıyı derlemesiz gönderir.
Spacefast'teki `--build` ve `--remote` bu yüzden yoktur. Derleme düşerse CLI derleme logunun son satırlarını gösterir
ve `recovery` alanına `perafly logs build --version vN` yazar. Kaynak yayınında klasördeki `.gitignore` kuralları da
uygulanır. Her yayın bir `Idempotency-Key` taşır, yeniden deneme güvenlidir.

| Bayrak | Varsayılan | Açıklama |
| --- | --- | --- |
| `[DIR]` | `.` | Klasör, tek HTML dosyası ya da `.zip` / `.tar.gz` arşivi |
| `--project`, `--team` | bağlı proje | Hedef (§3.3); çözülmezse yeni proje açılır |
| `-n, --name <ad>` | üretilir | Yeni projenin adı (slug); yalnız proje açılırken |
| `-m, --message <metin>` | son git iletisi | Sürüm notu |
| `--target live\|preview` | `live` | `preview`: sürüm hazır olur, `live` yerinde kalır. Dal biliniyorsa (CI ya da `--branch`) ve hedef verilmediyse gönderilmez: projenin dal kuralı seçer (§2.6) |
| `--branch <dal>`, `--commit <sha>` | CI'dan | Bu derlemenin Git dalı ve işlemesi; GitHub Actions, GitLab CI, Bitbucket ve CircleCI'da kendiliğinden (§2.6). Yalnız takım projesinde |
| `--publish-mode snapshot\|additive` | `snapshot` | `snapshot` bildirilmeyen yolu siler, `additive` bırakır |
| `--prebuilt` | kapalı | Hazır çıktı; Vercel derlemesi atlanır |
| `--build-command` ve diğer `build` alanları | `perafly.jsonc` | **Planlanan** (bayrak yok): bu yayın için `build` alanlarının üzerine yazar. Bugün `build` yalnız `perafly.jsonc`'den okunur (§5) |
| `--access private\|public` | takım varsayılanı | Yeni projenin ilk erişimi; `perafly.jsonc` `access`'inin önüne geçer. Yalnız yayın proje açarken: klasör bağlıysa, `--project` verildiyse ya da hesapsız yayında istemcide `validation_error` (çıkış 2). Yeni siteleri özel açan takımda `public` paylaşım izni ve tam profilli giriş ister; yoksa proje açılmadan 403 `access_change_forbidden` (çıkış 10): özel yayınla, erişimi sonra panelden değiştir |
| `--dry-run` | kapalı | Dosyaları, atlananları ve hedefi yazar; yüklemez |
| `--wait` / `--no-wait` | `--wait` | Hazır olana (canlıda `live` taşınana) dek bekler; `--no-wait` = `?async=1` |
| `--wait-timeout <sn>` | 900 (öneri) | Aşılırsa çıkış 50; işlem sunucuda sürer |

`--json` çıktısı: `data.project` (kimlik, ad, canlı adres), `data.version` (kimlik, numara, durum, sürüm adresi),
`data.live` (işaretçi taşındı mı), varsa `data.operation`; hesapsız yayında `data.claim` (anahtarın kendisi yok).
Dal bilgisiyle yayında `data.version.git` (`{ trigger, branch, commit, pullRequest, branchUrl }`) ve sunucu dal adresi
verdiyse `data.branchUrl` (`https://<ad>--br-<dal>.perafly.app`) eklenir.

### 2.2 `logs`

| Bayrak / argüman | Varsayılan | Açıklama |
| --- | --- | --- |
| `[kind]` | hepsi | `access` (istekler), `runtime` (kodun yazdığı satırlar), `build` (sürüm olayları ve derleme satırları; backend §18); virgülle birleşebilir (`access,runtime`). `logs build` alt komutu ise barındırıcının tek sürümlük derleme logudur |
| `--version <vN\|ver_…>` | — | Tek sürümün satırları |
| `-f, --follow` | kapalı | Yeni satırları izler (`after` imleciyle yoklama, 2 sn'de bir); Ctrl-C ile çıkılır. `--json`'da her satır ayrı bir JSON satırıdır (NDJSON) |
| `--follow-timeout <sn>` | — | İzlemeyi bu kadar saniye sonra bırakır (betik ve CI için) |
| `--since <zaman\|süre>` | — | Başlangıç: `2026-11-13T10:00Z` ya da `15m`, `2h`, `3d` |
| `--level <düzey>` | — | `info`, `warn`, `error`: bu düzey ve üstü |
| `--search <metin>` | — | İletide geçen metin (büyük-küçük harf duyarsız) |
| `--limit <n>` | 100 | Gösterilecek son satır sayısı (en çok 500) |

Satırlar eskiden yeniye yazılır. IP, tarayıcı kimliği ve sorgu dizesi sunucuda saklanmaz. Saklama süresi plana bağlıdır;
sunucu süreyi aşan sorguyu kırpar (`truncated: true`), CLI bunu söyler ve `--json`'da aynen geçirir.

### 2.3 `metrics` ve `top`

`perafly metrics` projenin ölçümlerini okur (backend §18.4): trafik (istek, sayfa görüntüleme, gün içi tekil ziyaretçi,
bant genişliği, durum kodları, önbellek, en çok açılan yollar ve yönlendirenler) ve kod çalıştıran projede fonksiyonlar
(çağrı, hata oranı, süre yüzdelikleri, CPU süresi, en yüksek ve ayrılan bellek). `perafly top` takımın projelerini
aralıkta istek sayısına göre sıralar (hata, bant genişliği, ziyaretçi, çağrı, derleme süresi).

| Bayrak | Varsayılan | Açıklama |
| --- | --- | --- |
| `--range <1h\|24h\|7d\|30d>` | `metrics` 24h, `top` 1h | Aralık |
| `-w, --watch` | kapalı | Yalnız `top`: ekranı tazeler (`--interval`, varsayılan 5 sn); `--count <n>` n tazelemeden sonra biter; `--json`'da her tazeleme bir satır |

Statik proje kod çalıştırmaz: CLI "bu proje kod çalıştırmıyor" der, sıfır göstermez. Ölçüm alınamazsa değer "—" yazılır
(`--json`'da `null`); ölçülmemiş ile sıfır ayrıdır. Çalışma alanının anlık CPU ve belleği backend Faz 6.6'da (Vercel
Sandbox) gelir; o güne kadar `workspace: null`.

### 2.4 `agent`

Yerleşik ajan oturumunu başlatır (`POST /v1/agent/sessions`) ya da var olan oturuma ileti gönderir
(`POST /v1/agent/sessions/{ags}/messages`) ve olayları izler (`GET …/events?after=<seq>`, 2 sn'de bir yoklama; SSE
planlanan). Aynı sohbet panelde ve mobilde sürer (backend §4.2). Alt komutlar: `agent ls`, `attach <ags>`,
`say <ags> "<ileti>"`, `stop`, `budget`, `allow`, `deny`.

| Bayrak / argüman | Varsayılan | Açıklama |
| --- | --- | --- |
| `["<tarif>"]` | — | Yeni oturumun tarifi; `--session` ile oturuma gidecek ileti. `-` stdin'den okur. `--session` verilip ileti yoksa oturumu izler (`attach`) |
| `--project <proje>` | — | Yeni oturum var olan projede çalışır; verilmezse proje ajanın ilk önizlemesiyle açılır. Klasörün bağlı projesi kendiliğinden kullanılmaz (planlanan) |
| `--new` | — | Yeni oturum açar (bayraksız da böyledir); `--session` ile birlikte verilemez |
| `--session <ags_…>` | — | Var olan oturumu sürdürür: iletiyi gönderir ve izler. `--project` ve `--budget` yalnız yeni oturumdadır (bütçe: `perafly agent budget <ags> <dolar>`) |
| `--detach` | kapalı | İletiyi gönderir, oturum kimliğini yazar, izlemez; `--no-wait` ile aynı (ikisi de geçerli) |
| `--budget <dolar>` | takım ayarı (5) | Yeni oturumun harcama tavanı |
| `--wait-timeout <sn>` | 3600 | İzlemeyi bırakır (çıkış 50); oturum sunucuda sürer |

- Terminalde ajan iletileri, araç çağrıları, alt ajan işleri, önizleme adresi, harcanan ve tavan bütçe görünür. `--json`
  ve ajan kipinde çıktı ajan durunca tek nesnedir (`{ session, events }`); olay başına satır (JSONL) planlanan.
  Ctrl-C yalnız izlemeyi bırakır.
- Ajan yalnız önizleme sürümü çıkarır. CLI canlıya almayı sormaz (soru planlanan): `perafly promote <sürüm> --project
  <ad>` komutunu yazar (`versions.promote` izni gerekir). Bütçe varsayılanı takım ayarından gelir; oturuma özel tavan
  `--budget <dolar>` ve `perafly agent budget <ags> <dolar>` ile yalnız tam profilli kişi anahtarıyla verilir (ajan
  profili 403: ajan kredisini başka bir ajan harcamaz, backend `docs/API.md` §17.6). Dolunca oturum duraklar, silinmez
  ve CLI bütçeyi yükseltme komutunu yazar.
- Veri bildirimi (içerik Anthropic'e gider; Fable 5.2 için 30 günlük saklama, backend §11) takım başına bir kez panelde
  onaylanır ve sunucuda kayıtlıdır. Onay yoksa sunucu `agent_consent_required` döner ve komut düşer (CLI'da sorma
  planlanan).

### 2.5 `setup agent` ve `mcp`

`setup agent` kurulu istemcileri bulur, MCP yapılandırmasını yazar, `perafly` becerisini kurar; CLI girişini kullanır.

| Bayrak | Varsayılan | Açıklama |
| --- | --- | --- |
| `--agent <id>` | algıla | `claude-code`, `cursor`, `codex`, `auto`, `all`; tekrarlanabilir |
| `--local`, `--remote`, `--oauth` | `--local` | Bağlantı türü (§6.1); `--oauth` yalnız `--remote` ile |
| `--skip-mcp`, `--skip-skill` | kapalı | MCP yazmaz, yalnız beceriyi kurar; beceriyi kurmaz, yalnız MCP'yi yazar |
| `--scope user\|project` | `user` | Beceriyi kullanıcı dizinine ya da bu projeye kurar |
| `--handoff` | kapalı | **Planlanan** (`setup agent`'ta bayrak yok): devir bağlantısı bugün `perafly login --handoff` ile stdin'den okunur ve klasöre tek projeye bağlı anahtar verir |
| `--force`, `--dry-run` | kapalı | Değiştirilmiş beceri dosyalarının üzerine yazar; yazmadan gösterir |

| Komut | Bayrak | Varsayılan | Ortam değişkeni |
| --- | --- | --- | --- |
| `perafly mcp` | `--workspace-root <dizin>` | çalışma klasörü | `PERAFLY_MCP_WORKSPACE_ROOT` |
| `perafly mcp proxy` | `--endpoint <url>` (yalnız HTTPS) | `https://mcp.perafly.com` | `PERAFLY_MCP_URL` |
| `perafly mcp install` | `--agent`, `--local`, `--remote`, `--oauth` | `setup agent` ile aynı | — |

Varsayılan yereldir: çalışma klasörünü doğrudan okur, dosyaları satır içi taşımaz. Köprüde barındırılan MCP CLI
anahtarını kabul eder (backend §9). `mcp` ve `mcp proxy` `--json` desteklemez; stdout MCP protokolünü taşır.

`login --access full|agent|read` istenen profili seçer (backend §4.3): varsayılan `full`, ajan kipinde `agent`.
Kullanıcı yetkilendirme sayfasında profili ve takımları daraltabilir; `projects rm` ve `api-keys create` yalnız `full`
profille çalışır.

### 2.6 `git`

Git'ten yayının iki yolu vardır (backend API §21): GitHub Uygulaması ve doğrudan itme. İkisinde de yalnız işlenmiş
içerik yayınlanır, dosyalar yayının süzgeçlerinden geçer ve sonuç bir sürümdür; derlemeyi Vercel yapar, CLI derleme
çalıştırmaz. Üçüncü yol CI'dan `perafly publish`'tir.

```bash
perafly git                             # GitHub bağlantısı, üretim dalı, otomatik yayın, itme adresi, son 5 derleme
perafly git set --repository acme/site  # depoyu bağla (Perafly GitHub Uygulaması önce panelden kurulur)
perafly git set --repository acme/site --installation 4823   # depo birden çok kurulumda görünüyorsa
perafly git set --production-branch main --auto-previews off
perafly git builds --status awaiting_approval
perafly git approve gbd_…               # çatal çekme isteği: önce isteği oku (onay ister)
perafly branches                        # dal adresleri ve sundukları sürüm

# Doğrudan itme: GitHub gerekmez
perafly git remote                      # "perafly" adında uzak adres ve yalnız o adres için kimlik yardımcısı
git push perafly HEAD:main              # üretim dalı canlıya
git push perafly HEAD:feature-login     # diğer dallar önizlemeye: https://<ad>--br-feature-login.perafly.app
```

| Kural | Açıklama |
| --- | --- |
| Uzak adres | `GET /v1/projects/{p}/git` → `push.url` (ör. `https://git.perafly.com/<proje>.git`; yerelde `<API>/git/<proje>.git`). Adres kimlik taşımaz; `.git/config`'e sır yazılmaz. `origin`'e hiç dokunulmaz (`--name origin` reddedilir); başka ad `--name` ile |
| Kimlik yardımcısı | `git remote` depo yapılandırmasına yalnız itme adresinin kökü için `credential.<köken>.helper` yazar: önce boş değer (bu adres için genel yardımcıları, ör. `osxkeychain`, sıfırlar; anahtar başka yardımcıya sorulmaz ve onda saklanmaz), sonra `!<perafly> git credential`. Varsayılan dışı API adresi ve açıkça seçilen profil satıra eklenir |
| `git credential get` | Git'in protokolü: stdin'den `anahtar=değer`; yalnız yapılandırılmış API'nin ana bilgisayarı ve onun `git.` kardeşi sorulursa (`api.perafly.com` → `git.perafly.com`, https) stdout'a tam iki satır: `username=perafly`, `password=<pfa_…>`. Anahtar `PERAFLY_TOKEN` ya da kayıtlı girişten; yoksa çıktı yok, çıkış 0 (Git sıradaki yolu dener). `store` ve `erase` bir şey yapmaz. Tanılama (`PERAFLY_DEBUG`) anahtarı yazmaz |
| Dallar | Üretim dalı canlıya (otomatik canlı yayın kapalıysa önizlemeye), diğerleri önizlemeye ve dal adresine (`<ad>--br-<dal>`; dal adı küçük harf, harf ve rakam dışı `-`). `--auto-production` ve `--auto-previews` `on\|off` |
| Canlıyı açmak | `--auto-production on` `versions.promote` ister; ajan profiliyle üretim dalına itiş canlıya alınırken onay bekler (§4.3). Bağlantı ayarlarını ajan profili değiştiremez |
| Çatal | Çataldan gelen çekme isteği `awaiting_approval` bekler. `git approve` çatalın kodunu projenin ortam değişkenleriyle (gizli anahtarlar dahil) derler: her kipte onay ister, ajan kipinde yalnız açık `--yes` geçer (`PERAFLY_YES` sayılmaz) |
| `disconnect` | GitHub'dan yeni derleme olmaz; sürümler ve dal adresleri kalır, doğrudan itme çalışır (onay ister) |

**CI'dan yayın.** `perafly publish` GitHub Actions (`GITHUB_HEAD_REF` ya da `GITHUB_REF_NAME`, `GITHUB_SHA`), GitLab CI
(`CI_COMMIT_REF_NAME`, `CI_COMMIT_SHA`, `CI_COMMIT_MESSAGE`, `CI_COMMIT_AUTHOR`), Bitbucket (`BITBUCKET_BRANCH`,
`BITBUCKET_COMMIT`) ve CircleCI'da (`CIRCLE_BRANCH`, `CIRCLE_SHA1`) dalı ve işlemeyi bulur ve gövdeye `git: { branch,
commit, message?, author? }` ekler; ileti ve yazar ortamda yoksa çekilmiş depodaki işlemeden okunur, yazarın e-postası
gönderilmez. `--branch` ve `--commit` her ortamda çalışır ve CI'ın önüne geçer. Dal bilinmiyorsa (etiket derlemesi
dahil) `git` gönderilmez. `--target` verilmediyse gönderilmez: sunucu projenin dal kuralını uygular; verilirse o kazanır.
Üretim dalı ayarlanmamışsa `main`'dir; ana dalı başka adlıysa `perafly git set --production-branch <dal>`.
Sürüm bir dal adresine yayınlandıysa sunucunun verdiği adres yazılır (`version.git.branchUrl` → `Branch URL`,
`--json`'da `data.branchUrl`); canlı ve üretim dalı yayınında yoktur ve CLI adresi kendisi kurmaz.

```yaml
# .github/workflows/perafly.yml
name: Perafly
on: [push]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npm run build
      # PERAFLY_TOKEN: deponun gizli değişkeni (perafly api-keys create ile üretilen pfa_… anahtarı). Proje depoya
      # işlenmiş .perafly/project.json'dan (perafly link) ya da PERAFLY_PROJECT / --project ile
      - run: npx perafly publish ./dist
        env:
          PERAFLY_TOKEN: ${{ secrets.PERAFLY_TOKEN }}
```

Üretim dalına (`main`) itiş canlıya, diğer dallar `https://<ad>--br-<dal>.perafly.app` önizlemesine gider. CI ajan kipidir
(`--json` açık, soru yok; `--yes` anlamına gelmez).

### 2.7 `storage` ve `sftp`

Proje depolaması sürüm dosyalarından ayrıdır: yol adresli, yaşayan dosyalar (backend §5 "Proje depolaması ve SFTP").
`public/` altı `https://<proje>.perafly.app/_files/<yol>` adresinden sunulur, `private/` yalnız anahtarla okunur.

```bash
perafly storage ls public/images
perafly storage put ./hero.jpg public/images/        # sonu / ise dosya adı korunur
perafly storage sync ./media public/media --dry-run
perafly storage get private/exports/2026-11.csv ./exports/
perafly storage mv public/old/ public/new/ && perafly storage rm public/tmp/ --yes

perafly sftp add deploy --key ~/.ssh/id_ed25519.pub --folder public/media --ip 203.0.113.0/24
perafly sftp ls
perafly sftp rm deploy --yes
```

| Kural | Açıklama |
| --- | --- |
| `put`, `get` | `put` iki istektir: yükleme adresi (`createStorageUpload`), sonra baytlar imzalı adrese (32 MB üstü akışla). `get` dosyayı imzalı adresten indirir; `-` stdout'a yazar. İmzalı adresler hiçbir çıktıya yazılmaz |
| `sync` | Eksik ya da boyutu farklı dosyaları yükler; uzakta hiçbir şey silinmez; `--dry-run` ne yükleneceğini gösterir. Yalnız yerelde karşılığı olan uzak klasörler okunur |
| Yerel dosyalar | Yayının dışlama kuralları geçerlidir (§9): `.env*`, anahtarlar, `.git`, `node_modules` hiçbir yoldan yüklenmez; sembolik bağ izlenmez |
| `rm`, `mv` | Sonu `/` olan yol klasördür (en çok 1000 dosya); `rm` onay ister, `mv` var olan hedefin üzerine yalnız `--overwrite` ile yazar |
| Sınırlar | Depolama boyutu, dosya başına boyut ve SFTP hesabı sayısı plana göredir; aşım 402 ve sınırın adını taşıyan `code` ile döner (çıkış kodu §4.2) |
| `sftp add` | `--key <dosya.pub>` (önerilen) ya da `--password` (üretilir, `pfs_…`, yalnız insan çıktısında bir kez gösterilir; `--json` ve ajan kipinde istek atılmadan reddedilir); `--readonly` ya da `--folder <klasör>`, `--ip <cidr>` (tekrarlanabilir), `--expires <ISO tarih>`. Çıktıda sunucu adı, port ve kullanıcı adı yazar |
| Kimlik üretimi | `sftp add` ve `sftp rm` yalnız `full` profille çalışır; ajan kimliğiyle yapılamaz (backend §4.3). Yalnız `.pub` dosyası okunur; özel anahtar açılmaz |
| Bağlanmak | CLI SFTP istemcisi değildir: bağlantı FileZilla, Cyberduck, WinSCP, `sftp` ya da `rsync` ile kurulur |

### 2.8 `data` ve `env`

Koleksiyon ve kayıtlar projenin headless veri katmanıdır (backend API §20.1–§20.4); ortam değişkenleri sonraki sürümde
geçerlidir (§20.5). İkisi de yalnız takım projesindedir.

```bash
perafly data collections create posts --schema posts.schema.json     # { fields, rules?, hook? }
perafly data ls posts --filter status=published --filter views:gte=100 --sort -createdAt --limit 20
echo '{"title":"Hello"}' | perafly data add posts
perafly data export posts --format csv --out posts.csv
perafly data keys                      # yayınlanabilir anahtar (pfp_…, tarayıcıda durur)
perafly data keys --create-secret      # gizli anahtar (pfk_…): bir kez gösterilir

printf %s "$DATABASE_URL" | perafly env set DATABASE_URL
perafly env ls
```

| Kural | Açıklama |
| --- | --- |
| Süzgeç | `--filter alan=değer` → `filter[alan]=değer`; `--filter alan:op=değer` → `filter[alan][op]=değer` (`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`: virgülle). Yalnız dizinli alanlarda ve `id`, `createdAt`, `updatedAt`'te |
| JSON girdisi | Şema ve kayıt `--schema`/`--file <dosya>` ya da stdin'den (`-`) okunur; terminalde dosya verilmezse sorulmaz |
| Anahtarlar | Yayınlanabilir anahtar sır değildir, `--json`'da görünür. Gizli anahtar yalnız insan çıktısında bir kez yazılır; `--create-secret` `--json` ve ajan kipinde istek atılmadan reddedilir. Site onu `PERAFLY_SECRET_KEY` olarak alır. Var olanı değiştirmek, yayınlanabilir anahtarı yenilemek ve gizliyi iptal etmek onay ister |
| `export` | Dosyadır, JSON çıktısı değildir: `--out` yoksa stdout'a akar; `--json` ile `--out` gerekir; dosya `0600` açılır |
| `env set` | Değer stdin'den ya da yankısız sorudan okunur, komut argümanından asla; değer çıktıya yazılmaz. Boşluk korunur (borudan gelende yalnız sondaki satır sonu atılır). `--plain` değeri ekipçe görünür kılar (`sensitive: false`) |

### 2.9 `api`, `inspect`, `docs`, `doctor`

```bash
perafly api GET /v1/me                                   # ham istek; yol /v1/… ya da /… (önüne /v1 eklenir)
perafly api GET '/projects?q=site' --json                # yanıt gövdesi tek satır
perafly api PATCH /projects/my-site --data '{"title":"My site"}'
perafly api POST /projects --data @project.json          # gövde dosyadan; --data - stdin'den
perafly api DELETE /projects/my-site/versions/v2 --yes   # DELETE onay ister
perafly inspect https://my-site--v3.perafly.app          # hangi proje, hangi sürüm
perafly docs custom domain --lang tr                     # belgelerde arama; giriş gerekmez
perafly doctor                                           # yerel kurulum denetimi
```

```text
$ perafly doctor
  OK    Node.js           22.11.0
  OK    CLI               0.9.0, npm package (/usr/local/lib/node_modules/perafly/dist/cli.js)
  OK    API               https://api.perafly.com reachable (142 ms)
  OK    Profile           default, team Acme (~/.perafly)
  OK    Credential store  system keyring
  OK    Sign-in           valid: Ada <ada@example.com>, team Acme, full access, expires 2026-12-14T10:00:00Z
  OK    Project link      my-site  https://my-site.perafly.app
  OK    perafly.jsonc     valid
  WARN  Git remote        perafly → https://git.perafly.com/my-site.git has no Perafly credential helper: git push will ask for a password
                          → perafly git remote --name perafly
  OK    Agent clients     claude-code: MCP (user), skill current; cursor: MCP (user)

No failures, 1 warning(s).
```

| Komut | Kural |
| --- | --- |
| `api <METHOD> <yol>` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. Kimlik: takım anahtarı, yoksa klasörün hesapsız proje anahtarı, yoksa kimliksiz. Yol yapılandırılmış API'de ve `/v1` altında kalır: mutlak adres, `//`, `\`, `.`/`..` parçası ve `#` istek atılmadan reddedilir (`validation_error`, çıkış 2). Gövde `--data <json>`, `--data @dosya` (dışlama kuralları geçerli, §9) ya da `--data -`; `GET` gövde almaz. `DELETE` etkileşimli kipte sorar, değilse açık `--yes` ister (ajan kipi onay değildir). Çıktı yanıt gövdesinin kendisidir (`{ data }` zarfı yok): güzel biçimli JSON, `--json` ile tek satır. 2xx dışı yanıt hata nesnesidir (stderr; sunucunun ek alanları `details`'te), stdout boş kalır, çıkış kodu §4.2. `-i, --include` durum ve başlıkları stderr'e yazar. Gövde, başlık ve hata karartılır: anahtar ve sır alanları `[redacted]` |
| `inspect <adres>` | `GET /v1/lookup?url=` (`lookupUrl`, `projects.read`; proje anahtarı da olur): tür (canlı, sürüm, dal önizlemesi, özel alan adı, depolama dosyası), proje, canlı sürüm, adresin gösterdiği sürüm ve dal. Başka takımın projesi ve bilinmeyen adres 404: "bu kimliğin göreceği bir Perafly projesi değil" (çıkış 20); biçimsiz adres çıkış 2. `--json` sunucunun nesnesi |
| `docs <sorgu>` | `GET /v1/docs/search` (`searchDocs`): kimlik gönderilmez. `--lang en\|tr` (varsayılan sistem dili: `LC_ALL`, `LC_MESSAGES`, `LANG`, `LANGUAGE` `tr` ile başlıyorsa tr, değilse en), `--limit 1–20` (varsayılan 8). Sonuç başlık, bağlam, adres ve kısa alıntı; `--json` liste. Dizin alınamazsa 503 `docs_unavailable` (çıkış 1) anlaşılır iletiyle |
| `doctor` | Satırlar: Node.js (≥ 22), CLI sürümü ve kurulum türü (npm paketi, npx, tek dosya ikili, yerel derleme), API adresi ve erişimi (kimliksiz `GET /v1/plans`, süre), profil ve takım, kimlik deposu (anahtar zinciri, düz dosya ve izni `0600` mı, `PERAFLY_TOKEN`, klasör anahtarı), giriş geçerli mi (`GET /v1/me`), proje bağı (`GET /v1/projects/{id}`), `perafly.jsonc` şemaya uygun mu, Git'te Perafly itme adresi ve kimlik yardımcısı, ajan istemcilerinde (Claude Code, Cursor, Codex) MCP yapılandırması, becerinin bu sürümle aynılığı ve `perafly`'ın PATH'te olup olmadığı. Ağ isteği yalnız API'ye gider; anahtarın değeri hiçbir satıra, `--json`'a ya da hataya yazılmaz. `--json`: `{ data: { ok, summary, checks: [{ id, title, status: ok\|warn\|fail, message, hint }] } }`. FAIL varsa rapordan sonra `doctor_check_failed` (çıkış 1); WARN çıkış kodunu değiştirmez. Yapılandırma dosyası bozuksa rapor yine yazılır (`Settings` FAIL) |

## 3. Genel bayraklar, ortam değişkenleri, dosyalar

### 3.1 Genel bayraklar ve ortam değişkenleri

| Bayrak | Ortam değişkeni | Açıklama |
| --- | --- | --- |
| `--json` | — | Makine çıktısı (§4) |
| `--project <hedef>` | `PERAFLY_PROJECT` | `prj_…`, ad, canlı adres ya da özel alan adı |
| `--team <takım>` | `PERAFLY_TEAM` | Takım adı ya da kimliği |
| `--api-url <url>` | `PERAFLY_API_URL` | Varsayılan `https://api.perafly.com` |
| `--profile <ad>` | `PERAFLY_PROFILE` | Adlandırılmış profil |
| `-y, --yes` | `PERAFLY_YES` (`1`, `true`, `yes`) | Yerel onayları geçer (§4.3) |
| `--cwd <yol>` | — | Komuttan önce klasör değiştirir; hedef çözümlemeyi etkiler |
| `--wait`, `--no-wait`, `--wait-timeout` | — | Kuyruklayan komutlarda (publish, promote, rollback, domains) |
| — | `PERAFLY_TOKEN` | API anahtarı (`pfa_…`); kayıtlı girişin önüne geçer; CI için önerilen yol |
| — | `PERAFLY_CLAIM_TOKEN` | Hesapsız projenin anahtarı (`pfc_…`); `.perafly/state.json`'ın önüne geçer |
| — | `PERAFLY_NON_INTERACTIVE` | Herhangi bir değer: hiç soru sorulmaz |
| — | `PERAFLY_AGENT` | `1`, `true`, `yes`: ajan kipi (§4.3) |
| — | `PERAFLY_AGENT_ALLOW_DESTRUCTIVE` | Ajan kipinde yalnız yerel koruma kaldıran işi (`unlink`) onaylar |
| — | `PERAFLY_HOME` | Durum dizini; varsayılan `~/.perafly` |
| — | `PERAFLY_CREDENTIAL_STORE` | `keyring` anahtar zincirini, `plaintext` düz dosyayı zorlar |
| — | `PERAFLY_MCP_WORKSPACE_ROOT`, `PERAFLY_MCP_URL` | §2.5 |
| — | `PERAFLY_DEBUG` | stderr'e tanılama; sır yazılmaz |
| — | `PERAFLY_TELEMETRY_DISABLED`, `DO_NOT_TRACK` | Telemetriyi kapatır (varsayılan zaten kapalı, §9) |
| — | `CI`, `NO_COLOR`, `FORCE_COLOR` | `CI` ajan kipi gibi davranır; diğerleri renk |
| — | `GITHUB_ACTIONS`, `GITLAB_CI`, `BITBUCKET_*`, `CIRCLECI` ve sağlayıcının dal/işleme değişkenleri | `publish` dalı ve işlemeyi buradan okur (§2.6); `--branch` ve `--commit` önüne geçer |

Spacefast'ten farklı olarak `--token <değer>` ve `--claim-token <değer>` yoktur: argüman kabuk geçmişine ve süreç
listesine düşer. Belirteç `PERAFLY_TOKEN` ya da `perafly login --token-stdin` ile verilir (§9).

### 3.2 Yapılandırma ve kimlik bilgisi konumları

| Konum | İçerik |
| --- | --- |
| `~/.perafly/config.json` | Profiller, varsayılan takım, API adresi |
| macOS Keychain, Linux Secret Service, Windows Credential Manager | Giriş anahtarı; önceliklidir. Kilitliyse `credential_keyring_unavailable` |
| `~/.perafly/credentials/<profil>.json` | Anahtar zinciri yoksa düz dosya, izin `0600`. Tek dosya ikilide her zaman burası (§8) |
| `perafly.jsonc` | Proje yapılandırması (§5); işlenir, yayınlanır, sunulmaz |
| `.perafly/project.json` | İşlenir: proje kimliği, takım, API adresi |
| `.perafly/state.json` | İşlenmez: hesapsız projenin anahtarı, önbellek. CLI `.gitignore`'a ekler |

### 3.3 Hedef çözümleme

Proje, ilk eşleşen kazanacak biçimde seçilir:

1. `--project` ya da `PERAFLY_PROJECT`.
2. `.perafly/state.json`'daki hesapsız proje; `.perafly/project.json` başka projeyi gösteriyorsa atlanır.
3. `.perafly/project.json`. Proje kimliğinin tek yeri burasıdır; `perafly.jsonc` kimlik taşımaz (§5).
4. `.perafly/state.json` önbelleği.
5. Hesapta tek proje varsa o; birden çoksa etkileşimli kipte sorulur, değilse `no_project_selected` (çıkış 2).
   `publish` bu adımda sormaz, yeni proje açar.

Takım: `--team` → `.perafly/project.json` → profilin varsayılanı → tek takım; çoksa sorulur ya da `no_team_selected`.
API adresi: `--api-url` → `PERAFLY_API_URL` → `.perafly/project.json` → profil → `https://api.perafly.com`. Kimlik
bilgisi yalnız verildiği API adresine gönderilir.

## 4. Makine çıktısı ve ajan kipi

### 4.1 `--json` sözleşmesi ve hata nesnesi

- Başarı: stdout'a yalnız `{ "data": … }`; liste uçları `{ "data": [...], "pagination": … }` olarak aynen geçer.
- Hata: stderr'e yalnız `{ "error": … }`; stdout boş kalır. Akış komutları (`logs -f`, `agent`) satır başına bir nesne
  yazar. Gizli değerler (anahtarlar, imzalı yükleme adresleri) `[redacted]` olur.

| Alan | Anlam |
| --- | --- |
| `code` | Kararlı kod (ör. `confirmation_required`); sunucu hatasında RFC 9457 yanıtındaki `code` aynen taşınır |
| `message` | İnsan için: ne oldu, ne yapılmalı |
| `status`, `type`, `title` | Sunucu hatasında HTTP durumu ve RFC 9457 alanları |
| `retryable`, `recovery` | Yeniden denenebilir mi; çalıştırılabilir sonraki komut (ör. `perafly rollback v2 --yes`) |
| `requestId`, `suggestions` | Destek için istek kimliği (yerel hatada `null`); yakın eşleşmeler (ör. proje adları) |
| `pointer` | Doğrulama hatasında hatalı girdiye RFC 6901 JSON Pointer (`perafly.jsonc` dahil) |

Sunucu kodları OpenAPI'de tanımlanır (ör. `noop_publish`). CLI'ın kendi kodları bu repoda tanımlanır: `auth_required`,
`credential_expired`, `credential_keyring_unavailable`, `confirmation_required`, `no_project_selected`,
`no_team_selected`, `validation_error`, `handoff_link_in_argv`; Git için `not_a_git_repository` (çıkış 2), `git_not_found`
ve `git_command_failed` (çıkış 1); `doctor` için `doctor_check_failed` (çıkış 1). Onay kodları (`approval_required`,
`approval_declined`) sunucudan gelir (§4.3).

### 4.2 Çıkış kodları

| Kod | Ad | Ne zaman |
| --- | --- | --- |
| 0 | ok | Başarı |
| 1 | unknown | Beklenmeyen hata; `doctor`'da düşen denetim |
| 2 | validation | Hatalı bayrak ya da argüman, HTTP 422, eksik onay |
| 10 | auth | HTTP 401/403, süresi dolmuş ya da eksik kimlik, kilitli anahtar zinciri |
| 20 | not-found | HTTP 404/410 (kapsam dışı kayıt da 404 döner, backend §11) |
| 30 | conflict | HTTP 409; plan ya da kredi sınırı (HTTP 402, sınırı adlandıran `code`) |
| 40 | network | Ağ hatası ve hız sınırı (HTTP 429, `Retry-After`); yeniden denenebilir |
| 50 | timeout | `--wait-timeout` aşıldı; iş sunucuda sürer |
| 130 | cancelled | Ctrl-C ya da reddedilen soru |

Onay bekleyen çağrı `--no-wait` ile `approval_required` (çıkış 2), reddedilen onay `approval_declined` (çıkış 10) verir.

### 4.3 Ajan kipi ve onaylar

- Soru yalnız stdin ve stdout terminalse, `--json` yoksa, `CI` ve `PERAFLY_NON_INTERACTIVE` tanımsızsa sorulur.
- `PERAFLY_AGENT=1` ya da `CI` varsa `--json` kendiliğinden eklenir ve sorular kapanır (`mcp`, `mcp proxy`, `api`,
  `--help`, `--version` hariç).
- Ajan kipi **asla `--yes` anlamına gelmez.** Yıkıcı uzak işlem her çağrıda açık `--yes` ister; yoksa
  `confirmation_required` (çıkış 2). `PERAFLY_AGENT_ALLOW_DESTRUCTIVE=1` yalnız yerel işleri (`unlink`) onaylar.

Onayın iki katmanı vardır, biri diğerinin yerine geçmez:

| Komut | Yerel onay (`--yes`) | Sunucu onayı (ajan profili, backend §4.3) |
| --- | --- | --- |
| `publish` (canlı hedef) | Hayır | Evet: canlı sürümün üzerine yayın (yeni proje ve önizleme hariç) |
| `promote` | Hayır | Evet |
| `rollback` | Evet | Evet |
| `domains add`, `domains rm` | `rm` için evet | Evet |
| `env set`, `env rm` | `rm` için evet | Ajan profiliyle yapılamaz (backend API §20.5) |
| `data collections rm`, `data rm`, `storage rm` | Evet | — |
| `data keys --rotate-publishable\|--revoke-secret`, `--create-secret` (var olanı değiştirirken), `sftp rm` | Evet | Ajan profiliyle yapılamaz |
| `projects rm`, `projects transfer` (planlanan), `api-keys create` | Evet (`api-keys create` hariç) | Ajan profiliyle yapılamaz |
| `versions rm`, `api-keys revoke`, `share revoke` | Evet | — |
| `git disconnect` | Evet | Ajan profiliyle yapılamaz |
| `git approve` | Evet; ajan kipinde yalnız açık `--yes` (`PERAFLY_YES` sayılmaz) | Ajan profiliyle yapılamaz |
| `api DELETE …` | Evet | Uç neyse onun kuralı (ham istek sunucu onayını beklemez; `approval_required` hata olarak döner) |

Sunucu onayı yalnız ajan profilli kimlikte aranır; `full` profilli kişi girişi beklemez. İstek panele ve mobile
bildirim olarak düşer, yaklaşık 10 dakika geçerlidir. CLI `--wait` ile kararı bekler; `--no-wait` ile
`approval_required` hatasında yürütme kimliğini (`exe_…`) ve onay bağlantısını döner, onaydan sonra
`perafly operations resume <exe_…>` işi sürdürür (MCP'de `resume_execution`). Bekleyen işin yerine ikinci iş
başlatılmaz.

## 5. `perafly.jsonc`

Derleme ve çatı algılama Vercel'indir; bu dosya yalnız üzerine yazar. Dosya yayınlanır ama sunulmaz. Kendi çalışma
zamanımız olmadığından `runtime` anahtarı yoktur.

| Anahtar | Tür | Anlam | Faz |
| --- | --- | --- | --- |
| `$schema` | string | Editör için şema adresi: `https://perafly.com/schemas/perafly.json` | 3 |
| `build` | object | `rootDirectory`, `installCommand`, `buildCommand`, `outputDirectory`, `framework` | 3 |
| `redirects` | array | Yönlendirmeler: `source`, `destination`, kalıcılık | 3 |
| `rewrites` | array | Adres yeniden yazma: `source`, `destination` | 3 |
| `headers` | array | Yanıt başlıkları: `source`, `headers: [{ key, value }]` | 3 |
| `crons` | array | Zamanlanmış işler (Vercel Cron): `path`, `schedule` | 9 |
| `access` | string | Projenin ilk erişimi: `private` ya da `public`; yalnız proje açılırken okunur | 8 |

Dosya proje kimliği taşımaz (`project`, `name` anahtarları yoktur): klasörün hangi projeye bağlı olduğu
`.perafly/project.json`'dadır, yeni projenin adı `publish --name` ile verilir (backend §3).

```jsonc
{
  "$schema": "https://perafly.com/schemas/perafly.json",
  "build": { "framework": "astro", "buildCommand": "npm run build", "outputDirectory": "dist" },
  "redirects": [{ "source": "/blog/:slug", "destination": "/yazilar/:slug", "permanent": true }],
  "headers": [{ "source": "/assets/(.*)", "headers": [{ "key": "Cache-Control", "value": "max-age=31536000" }] }],
  "crons": [{ "path": "/api/gunluk-ozet", "schedule": "0 6 * * *" }]
}
```

Şema bu repoda `schemas/perafly.json` olarak tutulur ve tek kopyadır; npm paketiyle birlikte dağıtılır, backend
doğrulama için aynı dosyayı paketten okur (backend §3). `perafly init` dosyayı `$schema` ile yazar; CLI yüklemeden önce
doğrular, hatayı `validation_error` ve `pointer` ile verir. `redirects`, `rewrites` ve `headers` Vercel'in `vercel.json`
alan adlarını kullanır; sunucu kuralları olduğu gibi geçirir.

## 6. Ajanlar

### 6.1 Bağlantı türleri

| Tür | Yazılan yapılandırma | Kimlik | Dosya sistemi |
| --- | --- | --- | --- |
| Yerel (varsayılan) | `perafly mcp` (stdio) | CLI girişi ya da `PERAFLY_TOKEN` | Çalışma klasörünü okur |
| Köprü (`--remote`) | `perafly mcp proxy` (stdio → HTTPS) | CLI girişi (`pfa_` anahtarı) | Yok; dosyalar satır içi |
| OAuth (`--remote --oauth`) | `https://mcp.perafly.com` (Streamable HTTP) | Editör, OAuth | Yok; dosyalar satır içi |

Köprü kimlik bilgisini yalnız onu veren API'nin ve MCP'nin adreslerine ya da yerel döngü adresine gönderir. Devir
bağlantısı (`pfh_…`, tek kullanımlık, 15 dakika) `login --handoff` ile stdin'den okunur (`setup agent --handoff`
planlanan) ve tek projeye bağlı anahtar verir; argüman olarak verilirse `handoff_link_in_argv` ile reddedilir.

### 6.2 Araçlar ve dosya erişimi

MCP araçları açık API'nin işlem adlarını taşır (`listProjects`, `promoteProjectVersion`, `lookupUrl`, `searchDocs`…);
buna şu üçü eklenir (backend §4.1). Liste elle yazılmaz, OpenAPI'den üretilir (§7); izinler barındırılan MCP'yle
aynıdır (`lookupUrl` `projects.read` ister, `searchDocs` ve `listPlans` her kimliğe açıktır).

- `publish`: yerelde `path` (klasör, dosya, arşiv) ya da çalışma klasörü; barındırılanda satır içi dosyalar.
- `operation_status`: `opr_…` durumunu sorgular; başarı yalnız uç durum başarılıysa bildirilir.
- `resume_execution`: onay bekleyen işi sürdürür; yerine ikinci iş başlatılmaz.

Yerel MCP'de kök sırası `--workspace-root` / `PERAFLY_MCP_WORKSPACE_ROOT` → istemcinin bildirdiği kök → başlangıç
klasörüdür. Kök dışındaki mutlak yol, köke kaçan yol (`..`), sembolik bağ, düzenli olmayan dosya ve kimlik bilgisi
benzeri dosya reddedilir; hiçbir yoldan yüklenmeyen dosyalar (§9) burada da dışlanır. Hesapsız yayında anahtar
`.perafly/state.json`'a yazılamazsa çağrı düşer; anahtar araç sonucuna yazılmaz.

### 6.3 Eklentiler ve beceri

Öneri: eklentiler `plugins/claude-code/`, `plugins/cursor/`, `plugins/codex/` altında, beceri `skills/perafly/`
(`SKILL.md` ve başvuru dosyaları) altında tutulur; her eklenti MCP yapılandırmasını ve beceriyi taşır. Beceri backend
§4.1'in kurallarını yazılı taşır: şemayı okumadan çağırma, yazmayı okuyarak doğrulamadan başarı bildirme, bekleyen
onayın yerine ikinci iş başlatma (`resume_execution` ile sürdür), `--yes`'i kendiliğinden ekleme. Beceri CLI ile
birlikte paketlenir.

## 7. Mimari ve önerilen repo yapısı

Node + TypeScript (backend §9). CLI ince bir istemcidir; sözleşme `GET https://api.perafly.com/openapi.json`'dadır.
OpenAPI'nin anlık görüntüsü repoda tutulur, tipli istemci ondan üretilir; CI'da canlı sözleşmeyle fark varsa iş düşer.
Uzak işlem yapan her komut bir `operationId` taşır (`perafly projects ls` → `listProjects`); MCP araç adları aynıdır.
CLI'a özgü mantık yalnız bildirim ve yükleme, kimlik saklama, hedef çözümleme, çıktı ve MCP dosya erişimidir.

```text
perafly-cli/
├── src/
│   ├── commands/          # komut başına bir dosya: bayrakları okur, işlemi çağırır, sonucu çıktıya verir
│   ├── api/               # openapi.json anlık görüntüsü ve ondan üretilen istemci (elle düzenlenmez)
│   ├── publish/           # bildirim (yol, boyut, sha256), dışlama kuralları, yükleme, işlem bekleme
│   ├── mcp/               # yerel MCP sunucusu (stdio), köprü, araç kaydı, dosya erişim denetimi
│   ├── auth/              # cihaz akışı, anahtar zinciri ve düz dosya deposu, belirteç seçimi
│   ├── config/            # profiller, hedef çözümleme, perafly.jsonc okuma ve doğrulama
│   ├── git/               # CI algılama, dal kuralları, uzak adres ve Git kimlik yardımcısı
│   └── output/            # insan çıktısı, --json zarfı, hata nesnesi, çıkış kodları
├── schemas/perafly.json   # perafly.jsonc JSON Şeması (tek kaynak)
├── plugins/               # claude-code/, cursor/, codex/
├── skills/perafly/        # beceri
└── test/                  # birim, sözleşme (OpenAPI) ve uçtan uca testler
```

MCP sunucusu ve köprü resmî TypeScript SDK'sıyla (`@modelcontextprotocol/sdk`) yazılır. Diğer seçimler karar değil,
öneridir: argüman ayrıştırıcı `commander` (hafif) ya da `oclif` (yardım ve komut haritası verir); OpenAPI istemcisi
`openapi-typescript` + `openapi-fetch`; paketleyici `tsup` (tek ESM çıktı); test koşucusu `vitest`; anahtar zinciri
`@napi-rs/keyring`; tek dosya ikili için Node SEA ya da `bun build --compile`.

## 8. Dağıtım ve sürümleme

- **npm** (Faz 3): paket `perafly`; ad 13 Kasım 2026'da npm'de boştu. `bin`: `perafly` ve `pf`. Yayın CI'dan, kaynak
  doğrulamasıyla (provenance) yapılır. En düşük Node sürümü 22'dir.
- **Tek dosya ikililer** (Faz 11): `perafly-darwin-arm64`, `perafly-darwin-x64`, `perafly-linux-x64`,
  `perafly-linux-arm64`, `perafly-windows-x64.exe`. Node SEA ile yapılır: içinde resmî Node derlemesi (şu an 24) ve
  bütün bağımlılıklar vardır, makinede Node gerekmez. Linux ikilileri glibc ister (musl, ör. Alpine: npm). macOS
  ikilileri yalnız ad-hoc imzalıdır (notarization yok); Windows ikilisi imzasızdır. **İkilide işletim sisteminin
  anahtar zinciri yoktur**: yerel modül (`@napi-rs/keyring`) ikiliye girmez, kimlik `~/.perafly/credentials/` altındaki
  `0600` dosyaya yazılır (`perafly login` "Stored in the credentials file" der, `--json`'da `store: "plaintext"`);
  `PERAFLY_CREDENTIAL_STORE=keyring` ikilide `credential_keyring_unavailable` verir. Anahtar zinciri isteyen npm
  paketini kullanır.
- **Homebrew**: tap deposundan, aynı ikililerle (macOS ve Linux).
- **Yapılandırma**: GitHub deposu ve tap adı `packaging/release.json`'dadır (tek kaynak). GitHub örgütü henüz karar
  değildir; değişirse burası ve kurulum betiklerindeki varsayılan depo satırı değişir (test eşliği denetler).

### 8.1 Kurulum

```bash
npm install -g perafly                     # Node 22+; anahtar zincirini kullanır
brew install perafly/tap/perafly           # macOS, Linux
curl -fsSL https://github.com/perafly/perafly-cli/releases/latest/download/install.sh | sh   # macOS, Linux
```

Windows: `irm https://github.com/perafly/perafly-cli/releases/latest/download/install.ps1 | iex`.

**Kurulum betiği** (`packaging/install.sh`, POSIX sh): platformu algılar (Rosetta altındaki kabukta yerel arm64),
ikiliyi ve `SHA256SUMS`'u indirir, **SHA-256 özetini doğrular, uymazsa hiçbir şey kurmaz**; ikiliyi kurulum klasöründe
çalıştırıp sürümünü denetler, `~/.perafly/bin/perafly`'a kurar (`pf` kısa adıyla, yoksa) ve PATH talimatı verir. sudo
istemez, kabuk dosyalarına dokunmaz; yalnız iki dosya indirir, belirteç ya da kişisel veri göndermez. Ortam
değişkenleri: `PERAFLY_VERSION` (ör. `0.9.0`; yoksa en son yayımlanan), `PERAFLY_INSTALL_DIR` (mutlak yol),
`PERAFLY_DOWNLOAD_BASE` (ayna ya da yerel deneme: dosyalar bu adresin altından alınır; https, http yalnız localhost).
`install.ps1` aynı değişkenleri okur ve `%USERPROFILE%\.perafly\bin`'e kurar.

**El ile**: GitHub Releases'ten ikiliyi ve `SHA256SUMS`'u indir, özeti doğrula, çalıştırılabilir yap ve PATH'teki bir
klasöre `perafly` adıyla taşı:

```bash
sha256sum -c SHA256SUMS --ignore-missing            # macOS: shasum -a 256 -c SHA256SUMS --ignore-missing
chmod +x perafly-linux-x64 && mv perafly-linux-x64 ~/.local/bin/perafly
```

Windows'ta `Get-FileHash -Algorithm SHA256 perafly-windows-x64.exe` çıktısı `SHA256SUMS`'taki satırla aynı olmalı.

### 8.2 Yerel derleme

- `npm run build:binary`: geçerli platformun ikilisi, `dist-bin/perafly-<os>-<arch>[.exe]` (işlenmez). Gömülen Node
  betiği çalıştıran Node'dur; resmî derleme olmalı (nodejs.org, nvm, `actions/setup-node`), paylaşımlı kütüphaneye bağlı
  Node (ör. Homebrew'unki) taşınabilir ikili vermez. Başka bir Node: `--node <yol>` ya da `PERAFLY_SEA_NODE`.
  `--expect-target <hedef>` makine başka hedef derlerse düşer.
- `npm run checksums`: `dist-bin/SHA256SUMS` (GNU `sha256sum` biçimi).
- `npm run homebrew:formula`: `packaging/homebrew/perafly.rb` şablonunu sürüm, depo ve `SHA256SUMS` ile doldurur →
  `dist-bin/perafly.rb` (macOS ve Linux'un dört ikilisinin özeti gerekir).

### 8.3 Yayın süreci

Yayımlamak kişinin kararıdır: iş akışı yalnız taslak açar; taslağı yayımlamak, tap'i güncellemek ve npm paketini açmak
(`package.json` `private`, karar 12) elle yapılır.

1. `package.json` sürümünü yükselt; `CHANGELOG.md`'de "Unreleased" başlığını sürüme çevir; ana dala birleştir.
2. İsteğe bağlı prova: Actions → Release → Run workflow (dry run açık, varsayılan). Typecheck, test, build; beş
   platformda ikili ve duman testi; `SHA256SUMS`, `perafly.rb` ve kurulum betikleri yapıt olarak kalır, hiçbir şey
   yayımlanmaz.
3. Etiketi it: `git tag v<sürüm> && git push origin v<sürüm>`. İş akışı etiketi `package.json` sürümüyle karşılaştırır,
   aynı denetimleri yapar ve dosyaları **taslak** GitHub Release'e yükler (yayımlanmış sürümün dosyalarını değiştirmez).
4. npm yayını yalnız etikette ve `--provenance` ile yapılır; `NPM_TOKEN` sırrı yoksa ya da `package.json`
   `private: true` ise adım atlanır.
5. Taslağı gözden geçir: bir ikiliyi indir, `SHA256SUMS` ile doğrula, `--version`'ı dene; sonra el ile yayımla.
6. Homebrew: taslaktaki `perafly.rb`'yi tap deposundaki `Formula/perafly.rb`'ye kopyala ve işle.

- **Sürümleme**: anlamsal. `--json` biçimi, hata `code`'ları, çıkış kodları, ortam değişkenleri ve `perafly.jsonc`
  şeması sözleşmedir; bunları bozan değişiklik ana sürüm ister. Faz 4 bitene dek `0.x`. Değişiklik günlüğü
  `CHANGELOG.md`'dedir ve sözleşme değişikliğini ayrıca yazar (araç önerisi: Changesets).

## 9. Güvenlik

- **Kimlik bilgisi**: önce işletim sisteminin anahtar zinciri, yoksa `0600` izinli düz dosya. Yalnız verildiği API
  adresine gider; profil ya da `--api-url` değişince başka adrese gönderilmez.
- **Belirteç argümanda verilmez**: API anahtarı `PERAFLY_TOKEN` ya da `perafly login --token-stdin`; devir bağlantısı,
  `env set` değeri ve paylaşım parolası stdin'den ya da sorudan okunur. Sır belirteci (`pfa_`, `pfc_`, `pfs_`, `pfk_`,
  `pfw_`, `pfo_`, `pfr_`, `pfl_`, `pfh_`) taşıyan argüman komut çalışmadan reddedilir; yayınlanabilir anahtar (`pfp_`)
  sır değildir.
- **Hiçbir yoldan yüklenmeyen dosyalar**: `.env*`, `.git`, `node_modules`, `*.pem`, `*.key`, `id_rsa`,
  `.perafly/` (state.json dahil); ayrıca kimlik dosyaları (`.npmrc`, `.netrc` …), kimlik klasörleri (`.ssh`, `.aws`),
  Git dosyaları (`.gitignore` …) ve işletim sistemi artıkları (`src/publish/exclude.ts`). Ev klasörü ve dosya sistemi
  kökü yayınlanmaz. CLI bunları bildirime koymaz, sunucu da reddeder (backend §11). Sembolik bağlar atlanır, kök
  dışına çıkan yol izlenmez; `--dry-run` atlananları gösterir.
- **Git kimliği adrese gömülmez**: `git remote` uzak adrese ve git yapılandırmasına belirteç yazmaz; yardımcıyı yalnız
  itme adresinin kökü için kurar ve o adresteki başka yardımcıları sıfırlar (anahtar Git'in başka bir deposunda
  saklanmaz). Yardımcı anahtarı yalnız yapılandırılmış API'nin ana bilgisayarına ve `git.` kardeşine
  (`git.perafly.com`), yalnız Git istediğinde verir. SFTP parolası bir kez gösterilir, diske yazılmaz.
- **Çıktı**: anahtarlar ve imzalı adresler ekrana, `--json`'a ve `PERAFLY_DEBUG` loglarına yazılmaz. Hesapsız projenin
  anahtarı yalnız `.perafly/state.json`'da (izin `0600`) durur. Ajan tavanı, izinler ve onaylar backend §4.3'e göre
  sunucuda uygulanır; CLI yalnız gösterir.
- **Telemetri**: varsayılan kapalıdır; ilk sürümlerde hiç toplanmaz. İleride eklenirse açık rızayla açılır; dosya
  içeriği, yol adı ve belirteç toplanmaz; `PERAFLY_TELEMETRY_DISABLED` ya da `DO_NOT_TRACK` her durumda kapatır.

## 10. Fazlara göre CLI işi

Faz 0–2'de bu repoda kod yazılmaz (Faz 0'da repo git'e alınır); CLI, Faz 2'deki `POST /v1/publish`, işlemler ve
OpenAPI'ye dayanır. Bitti ölçütleri backend §13'ten kısaltılmıştır; 5 ve 7 CLI'a göre daraltılmıştır.

| Faz | CLI işi | Bitti ölçütü |
| --- | --- | --- |
| 3 | §2'deki Faz 3 komutları; hesapsız yayın, sahiplenme; şema | `npx perafly publish ./dist` hesapsız çalışıyor |
| 4 | §2'deki Faz 4 komutları; sunucu onay akışı | Claude Code MCP ile yayınlıyor; riskli iş onay bekliyor |
| 5 | `usage` | Dönem kullanımı ve harcama sınırı görünüyor |
| 6 | `agent` | Tariften önizleme sürümü çıkıyor; onayla canlıya alınıyor |
| 7 | `logs`, `metrics`, `top` (bitti) | Loglar izleniyor; CPU ve RAM backend §6'daki gibi görünüyor |
| 8 | `domains`, `share` (bitti); `perafly.jsonc` `access` ve `publish --access` Faz 11'de (bitti) | Özel proje yalnız yetkiliye açılıyor; alan adı SSL ile canlı |
| 9 | `env`, `data`, `storage`, `sftp`, `perafly.jsonc` `crons` | Koleksiyon şeması dosyadan uygulanıyor; `storage sync` bir klasörü depolamaya eşitliyor; `sftp create` ile açılan hesap bağlanıyor |
| 10 | `git` (durum, ayarlar, uzak adres, kimlik yardımcısı, derlemeler, çatal onayı), `branches`; CI'dan yayın (`PERAFLY_TOKEN` + `perafly publish`, dal algılama) (bitti; elle derleme ucu yok) | Ana dala itiş canlıya, diğer dal önizlemeye gidiyor; `git push perafly HEAD:main` GitHub olmadan yayınlıyor |
| 11 | `api`, `inspect`, `docs`, `doctor`, `publish --access`, `agent --session\|--new\|--detach`, yerel MCP'de `lookupUrl` ve `searchDocs` (bitti); tek dosya ikililer ve kurulum betikleri (§8). Planlanan: `projects transfer`, `publish --build-command` ve diğer `build` bayrakları, `skills status\|remove`, `plugins` | `perafly doctor` kurulumu açıklıyor; `perafly inspect <adres>` projeyi buluyor |

## 11. Geliştirme düzeni

Backend §10 burada da geçerlidir: lider ve alt ajan iş bölümü, önce sözleşme (uç OpenAPI'ye girmeden komutu yazılmaz),
özellik sırasında CLI'ın web ve mobilden sonra gelmesi, tip denetimi ve testler temiz olmadan işin bitmiş sayılmaması.
Güvenlik sınırı olan kod (`src/auth/`, `src/publish/` dışlama kuralları, `src/mcp/` dosya erişimi) alt ajana verilmez.

## Açık sorular

1. **Açık kaynak ve lisans**: CLI açık kaynak mı olacak, lisansı ne (backend §14 karar 12)? Eklentiler ve beceri aynı
   repoda mı kalır, ayrı bir `plugins` reposuna mı çıkar?
2. **`access` kapsamı**: `perafly.jsonc`'de yalnız `private` / `public` mi kalır, Faz 8'de yol bazlı kurallara
   (ör. yalnız `/docs/**` herkese açık) genişler mi?
3. **`perafly agent` oturumunu durdurma**: Ctrl-C yalnız izlemeyi bırakır; çalışan oturumu terminalden kesmek için
   ayrı bir komut gerekli mi, panel yeterli mi?
4. **Yerel derleme seçeneği**: CLI derleme çalıştırmaz (karar). Hesapsız kullanıcı için `perafly publish --build`
   benzeri bir kolaylık ileride istenir mi?

Bu README'nin ilk taslağındaki diğer sorular backend README'de karara bağlandı: giriş profilleri ve onay kapsamı
(§4.3), köprünün kimliği, yürütme sürdürme, devir, sürüm silme ve takım kullanımı uçları, derleme logunun fazı, hız ve
plan sınırı kodları (§9), yapılandırma dosyasının kimlik taşımaması ve şemanın tek kopyası (§3).
