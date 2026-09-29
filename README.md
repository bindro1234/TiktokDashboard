# TikTok-campagne tracker

Houdt de TikTok-statistieken bij van de klas tijdens de Social Media Campagne (28 sept – 26 okt 2026) en toont de stand op een website.

```
Bright Data (TikTok-scraper)  →  GitHub Actions (collector/)  →  Google Sheets  →  website (site/, GitHub Pages, alleen handles)
                                                                              ↘  beheerpagina (private/, Cloudflare, met namen, achter inlog)
```

- **Profielen** van alle accounts worden **elke 2 uur** opgehaald, dag en nacht (00:00, 02:00, …, 22:00 Nederlandse tijd). Eén profiel kost 1 record en bevat de statistieken van de ~16 nieuwste video's. Tijdens een **finale** (zie *Beheerpagina*) elke 15 minuten.
- **Weekrefresh** op vrijdag vanaf 08:30: haalt alleen campagneposts op die ouder zijn dan dat venster van ~16 video's, zodat late weergaven op oudere video's ook meetellen. Accounts waarbij het venster al teruggaat tot vóór de campagnestart worden overgeslagen (0 records).
- Alleen video's die zijn geplaatst **vanaf 28 september** tellen mee. Foto-/carrouselposts tellen mee, reposts niet.
- Weergaven van een video kunnen nooit omlaag: valt een video uit het venster, dan blijven de laatst bekende cijfers staan.
- Per post worden ook de **hashtags** bewaard (kolom `hashtags` in `posts_latest`, zonder `#`, gescheiden door spaties).
- **Per video over tijd** (`post_history`): voor pieken en de snelste stijgers. Licht gehouden: een rij per run zolang een video jonger is dan 72 uur, daarna hoogstens één rij per 6 uur, en alleen als de weergaven of likes veranderd zijn. Verwacht aan het eind van de campagne ≈ 55.000–90.000 rijen (≈ 3,5–5,5 MB als CSV; tot ≈ 8 MB als iedereen twee keer per dag post).
- **Verdwenen video's:** staat een video niet meer in het venster terwijl hij daar nog wel in hoort (hij is nieuwer dan de oudste video in het venster), dan krijgt hij in `posts_latest` de kolom `missing_since` (tijd van de run waarin hij voor het eerst ontbrak). Waarschijnlijk verwijderd of verborgen. De laatst bekende cijfers blijven meetellen. Duikt de video weer op, dan wordt `missing_since` weer leeg.

## Privacy

- De repository en de website zijn **openbaar**. Er staan geen sleutels, geen namen en geen gescrapete data in de repo.
- Er zijn **twee spreadsheets**:
  - **Privé** (`admin_id` in `config.yaml`): tabblad `accounts` met namen, plus `run_log` en `profile_window`. Deze sheet **nooit** publiceren of delen via een link.
  - **Openbaar** (`data_id`): alleen TikTok-handles. Deze wordt gepubliceerd als CSV en de website leest die.
- De logs van GitHub Actions zijn openbaar; de collector schrijft daar alleen handles en aantallen in, nooit namen.
- Namen zijn alleen te zien op de **privé-beheerpagina** (zie hieronder). Die leest de privésheet rechtstreeks via het service-account en staat achter Cloudflare Access; namen gaan nooit naar de repo, de openbare sheet, de openbare site of de Actions-logs.

## Tabbladen

| Sheet | Tabblad | Inhoud |
|---|---|---|
| privé | `accounts` | `student_name`, `tiktok_handle`, `active` (ja/nee) — **dit vul je zelf in** |
| privé | `run_log` | per run: tijd, type, venster, dry-run, verwachte en echte records, fouten, status, notities |
| privé | `profile_window` | per account: hoeveel video's het profiel teruggaf en de oudste datum daarvan (voor de weekrefresh) |
| privé | `activity_log` | wie (e-mail) wat deed op de beheerpagina en wanneer: geopend (1× per dag), nu verversen, leerling toegevoegd/(de)geactiveerd, finale gestart/gewijzigd/gestopt, export. Wordt vanzelf aangemaakt |
| privé | `finale` | per finale: start, wie, deadline, status (`active`, `stopped` = vroeg gestopt, `cancelled` = geannuleerd), wanneer gestopt en door wie. De laatste rij telt |
| openbaar | `handles` | actieve handles, privé ja/nee, laatste status |
| openbaar | `profile_snapshots` | volgers, volgend, likes, aantal video's per run |
| openbaar | `posts_latest` | één rij per video (`video_id`), steeds bijgewerkt met de nieuwste cijfers, plus `hashtags`, `missing_since` en `hist_*` (laatste `post_history`-rij) |
| openbaar | `history` | per run per account: totaal weergaven, volgers, likes en posts in de campagne (voor de grafieken) |
| openbaar | `post_history` | per video over tijd: `video_id`, `handle`, `timestamp`, `views`, `likes` (licht gehouden, zie boven) |
| openbaar | `finale` | kopie van de huidige finale zonder namen of e-mail: start, deadline, status, gestopt (voor de aftelklok en de Eindstand op de openbare site) |

### Accounts toevoegen

Zet in `accounts` per leerling een rij. De handle mag in elke vorm: `@naam`, `naam`, `https://www.tiktok.com/@naam`, met hoofdletters of spaties. Ongeldige handles (bijv. een korte `vm.tiktok.com`-link) worden overgeslagen en gemeld in `run_log`; de run gaat gewoon door. Zet `active` op `nee` om een account niet meer te volgen (leeg = ja).

## Kosten en budget

- Bright Data rekent per record: 1 profiel = 1 record, 1 post = 1 record. 5.000 records per kalendermaand zijn gratis, daarna ca. $1,50 per 1.000.
- **Harde limiet:** `budget.monthly_cap` in `config.yaml` (nu **17.500**; boven de gratis 5.000 is het pay-as-you-go). Vóór elke run telt de collector de records van deze maand op uit `run_log` en weigert de run (status `refused`) als het totaal boven de limiet zou komen. Ook elke finale-run.
- Vóór een weekrefresh of controle wordt ook budget **gereserveerd** voor alle profielruns die deze maand nog komen, zodat de hoofdbron nooit zonder budget komt te zitten.
- De weekrefresh haalt maximaal `posts_refresh.num_of_posts` posts per account op (nu **40**). Dat is ook de bovengrens die de dry-run gebruikt en die wordt gereserveerd.
- **Schatting oktober** (profielen elke 2 uur, 26 dagen × 12 runs):

  | | 40 accounts | 45 accounts |
  |---|---|---|
  | profielruns | 12.480 | 14.040 |
  | weekrefreshes (4×) | ≈ 600–1.150 | ≈ 700–1.300 |
  | Nu verversen (≈ 5×) | ≈ 200 | ≈ 225 |
  | **totaal zonder finale** | **≈ 13.300–13.800** | **≈ 15.000–15.600** |
  | finale van 2 uur (+7 runs) | +280 | +315 |
  | finale van 8 uur, het maximum (+28 runs) | +1.120 | +1.260 |

  Boven de gratis 5.000 kost dat bij 45 accounts ≈ $15–17 (≈ €14–16).
- **Waarom 17.500:** de weekrefreshes van 16 en 23 oktober reserveren eerst alle resterende profielruns van de maand. Bij meer dan ~42 accounts passen ze dan niet binnen 16.000 (ze zouden `refused` worden); met 17.500 passen ze bij 45 accounts, en is er ook ruimte voor een finale van 8 uur (≈ 15.600 + 1.260 = 16.860). De limiet is een bovengrens, geen verbruik: betaald wordt alleen wat echt wordt opgehaald.

## Schema

GitHub-cron draait in UTC en is vaak 5–30 minuten te laat of slaat soms een keer over (en bij een nieuwe repo soms urenlang alles). Daarom start de workflow meerdere keren per tijdvak, en kijkt de collector zelf naar de Nederlandse tijd en `run_log`: elk tijdvak draait precies één keer, en een mislukte poging wordt bij de volgende start opnieuw geprobeerd (maximaal 2 keer). Zomer- en wintertijd gaan zo vanzelf goed.

| Run | Tijdvak (Amsterdam) |
|---|---|
| Profielen | elke 2 uur, dag en nacht: 00:00–00:59, 02:00–02:59, …, 22:00–22:59 (12 per dag) |
| Weekrefresh | vrijdag 08:30 – 10:00 |
| Eenmalige controle | 5 okt, direct na de run van 22:00 |
| Finale | alleen als je hem start op de beheerpagina: elke 15 minuten tot de deadline |

**Twee timers.** GitHub-cron (`collect.yml`) vuurt elk uur om :10, :30 en :50. Omdat die niet betrouwbaar is, heeft de beheerpagina-Worker een eigen *Cron Trigger* (`[triggers]` in `private/wrangler.toml`): **elke 5 minuten**. Die kijkt naar de tijdvakken uit `config.yaml`, naar een lopende finale (tab `finale` in de privésheet) en naar `run_log`. Staat er een tijdvak of een finale-run open die nog niet gedraaid heeft, en loopt de collector nog niet, dan start de Worker *Collect TikTok stats* met `auto` (via `GH_DISPATCH_TOKEN`). De collector controleert dat daarna zelf nog een keer. Starten ze allebei, dan doet de tweede niets en kost niets: elk tijdvak draait maar één keer. Zomer- en wintertijd: beide timers vuren elk uur, dus ook de dag van de klokwissel (25 okt) gaat goed; de tests controleren dat voor beide. Wat de timer deed staat in de Worker-logs (Cloudflare → Workers & Pages → tiktok-beheer → Logs).

**Net ververst?** Een geplande profielrun wordt overgeslagen (status `skipped`, 0 records) als er minder dan 60 minuten eerder al een echte profielrun was, bijvoorbeeld via *Nu verversen* om 13:30 (dan vervalt de run van 14:00; de volgende is om 16:00). Finale-runs worden nooit overgeslagen. Instelbaar via `schedule.skip_if_profiles_ran_within_minutes`.

Alles staat in **`config.yaml`**. Pas je tijden aan, controleer dan ook de cron-regels in `.github/workflows/collect.yml` en `private/wrangler.toml` (de test `test_crons_cover_every_window` controleert dat).

### Eenmalige controle (proefweek)

De regel "weekrefresh overslaan als het venster tot vóór de campagne teruggaat" gaat ervan uit dat het profiel écht de **nieuwste** video's teruggeeft. Dat is nog niet bewezen. Daarom haalt de controle (`window_check` in `config.yaml`) voor de 4 accounts met de meeste video's alle campagneposts op. Die worden vergeleken met wat wij al hadden. Het verslag staat in `run_log` (notities) en in de samenvatting van de GitHub Actions-run:

- **missing**: video's die wij niet hadden;
- **missing inside window**: gemiste video's die nieuwer zijn dan de oudste video in het venster. Is dit meer dan 0, dan is het venster níét simpelweg "de nieuwste video's" en moeten we de refresh-regel aanpassen;
- **max views lag**: hoeveel onze weergaven maximaal achterliepen.

Vastgezette (gepinde) video's en reposts tellen niet mee bij het bepalen van de oudste datum in het venster.

## Handmatig draaien

In GitHub: **Actions → Collect TikTok stats → Run workflow**. Kies een commando (standaard een **dry-run**, die alleen logt hoeveel records het zou kosten):

| Commando | Wat |
|---|---|
| `status` | verbruik deze maand, resterende runs, problemen in `accounts` |
| `profiles` | profielen nu ophalen (zonder 30-minutengrens) |
| `refresh` | weekrefresh nu |
| `check` | eenmalige controle nu (optioneel eigen lijst handles) |
| `auto` | wat een geplande run ook doet |
| `setup` | tabbladen en kopregels aanmaken (veilig om opnieuw te draaien) |

Lokaal (Python 3.11):

```bash
pip install -r requirements.txt
export GOOGLE_SERVICE_ACCOUNT_B64=...   # base64 van de service-account-JSON
export BRIGHTDATA_API_KEY=...           # zet dit NOOIT in een bestand in de repo
python -m collector status
python -m collector profiles --dry-run
python -m unittest
```

## Presentatiemodus (voor de docent)

Voor de beamer aan het begin van de les: klik op de site op **▶ Presentatie**, of ga naar **`https://bindro1234.github.io/TiktokDashboard/?present`**

- Gemaakt voor 1920×1080 en 1280×720: grote letters, alles past op één scherm, niets scrollt.
- Wisselt automatisch elke 15 seconden:
  1. **Top 3** op een podium;
  2. **de rest van de stand** in pagina's van 10 (plaats 4–13, 14–23, …), met ▲▼ en *+ 24 uur*;
  3. **grafiek** van de weergaven van de top 8;
  4. **Stijgers**: de grootste groei in weergaven in de laatste 24 uur.
- Geen tabbladen en geen beheerdersknoppen; alleen TikTok-handles. Rechtsboven zit een klein knopje voor **volledig scherm**. De muisaanwijzer verdwijnt na 3 seconden stilstand.
- **Zelf doorklikken:**
  - klik op een **bolletje** onderaan om naar die dia te springen;
  - **→**, **spatiebalk** of **PageDown**: volgende dia;
  - **←**, **Shift+spatie** of **PageUp**: vorige dia (een presentatieclicker werkt dus ook);
  - na de laatste dia kom je weer bij de eerste, en andersom. Na elke sprong begint de timer van die dia opnieuw.
- **Pauzeren:** toets **P**, **.** of **B** (de "zwart scherm"-knop van een presentatieclicker stuurt `.` of `B`), of het knopje **⏸/▶** naast de bolletjes. Zolang het gepauzeerd is staat er *gepauzeerd* onderaan en blijft de dia staan; doorklikken kan gewoon en houdt de pauze vast. Nog een keer drukken speelt weer af.
- **Finale:** loopt er een finale, dan staat onderaan een **aftelklok** tot de deadline en staat er **LIVE** bij de titels; de cijfers verversen dan elke 2 minuten. Na de deadline toont de presentatie alleen nog de **Eindstand**: het podium en de hele stand, bevroren op de laatste meting vóór de deadline.
- Standaard een **licht** thema (beamers maken donkere achtergronden flets). Donker: `?present&donker`.
- Rechtsonder staat klein *Bijgewerkt: …*. De gegevens verversen vanzelf (elke 10 minuten); nieuwe cijfers komen in de volgende dia.
- Testen hoe de finale eruitziet kan met `?nu=2026-10-26T15:30` (doet alsof het dat moment is, alleen in jouw browser).
- Instellen in `site/config.js` onder `present`: seconden per dia (`slideSeconds`), accounts per pagina (`pageSize`), accounts in de grafiek (`graphAccounts`, max. 8) en rijen bij de stijgers (`risers`). Tijdelijk een andere snelheid: `?present&sec=20`.

## Nu verversen (alleen beheerder)

Extra profielrun buiten het schema, bijvoorbeeld vlak voor de les.

1. Open de **privé-site** (achter Cloudflare Access) en ga naar **Beheer**. Klik op **↻ Nu verversen**. Nieuwe cijfers staan binnen ~5–7 minuten op beide sites.
2. Alternatief zonder privé-site: op GitHub onder **Actions → Nu verversen → Run workflow** (alleen met schrijfrechten op deze repo).

De openbare site heeft geen beheerdersknop meer (de oude `?beheerder`-link doet niets meer).

Beveiliging en kosten:

- De openbare site bevat **geen tokens of sleutels** en geen beheerfuncties. De privé-site start de workflow via de Worker, die de Access-login zelf controleert.
- Een run haalt alle actieve profielen op (1 record per account) en valt onder dezelfde **maandlimiet**.
- **Dubbel tikken kost niets extra:** was de laatste echte profielrun (gepland of handmatig) minder dan 30 minuten geleden, dan wordt de run geweigerd en als `refused` gelogd in `run_log` (instelbaar via `force_refresh.min_minutes_between` in `config.yaml`). Loopt er net een geplande run, dan wacht de workflow daarop en wordt hij daarna geweigerd.

## Beheerpagina (privé, met namen)

Een aparte website voor docenten, op Cloudflare (gratis), achter **Cloudflare Access**: alleen e-mailadressen op de lijst komen erin, met een eenmalige code per mail (geen wachtwoorden). Iedereen op de lijst ziet alles. De code staat in `private/`; de Worker leest en schrijft de privésheet live met het service-account en controleert zelf bij elk verzoek het Access-token (handtekening, AUD, uitgever, verloopdatum). Zonder geldig token: *Geen toegang*.

| Tabblad | Wat |
|---|---|
| **Overzicht** | alle gevolgde leerlingen met naam en handle, sorteerbaar, met waarschuwingen: *privé*, *niet gevonden*, *nog niet opgehaald*, *X dagen geen post* (2 of meer), *video verdwenen*. Geen naam ingevuld = <mark>onbekend</mark>. Na een finale: *Eindstand* |
| **Leerlingen** | kalender per campagnedag (Nederlandse tijd): gepost / gemist / nog niet, met reeks en gemiste dagen. Klik voor details: gemiste dagen, huidige en langste reeks, gem. weergaven per post, beste video (link), engagement = (likes + reacties + gedeeld) / weergaven, hashtags, **weergaven per video over tijd** (snelste stijger gemarkeerd) en alle posts |
| **Stijgers** | de video's met de meeste nieuwe weergaven in de laatste 2, 6 of 24 uur, met naam |
| **Hashtags** | meest gebruikt en meeste weergaven, met wie ze gebruikt |
| **Presentatie** | de presentatiemodus, met voornamen erbij (alleen hier); ook met pauze, aftelklok en Eindstand |
| **Beheer** | **Finale** (zie hieronder), *Nu verversen* (zelfde 30-minutengrens), leerling toevoegen, leerlingen (de)activeren (nooit verwijderen: `active` wordt `nee`), budget t.o.v. de limiet, schema, laatste runs en fouten, ongeldige/dubbele handles, activiteitenlog |
| **Export** | CSV voor de beoordeling (Excel NL of standaard), één rij per leerling |

Limiet en schema staan alleen in `config.yaml`; de beheerpagina toont ze (ze worden bij elke deploy meegenomen).

### Finale (laatste les)

Op **Beheer → Finale**:

1. Kies de **deadline** (datum + tijd, Nederlandse tijd) en klik **▶ Start finale**. Je ziet vooraf wat het kost: 4 runs per uur × het aantal actieve accounts (bij 40 accounts ≈ 160 records per uur), en of het binnen de maandlimiet past; zo niet, dan start hij niet.
2. Tijdens de finale: profielen **elke 15 minuten** (de 2-uurlijkse runs vervallen dan), op de presentatie (openbaar en privé) en bovenaan beide sites een **aftelklok** en **LIVE**-labels. De eerste run start meteen.
3. Bij de deadline stopt hij vanzelf; hij duurt **nooit langer dan 8 uur** (`finale.max_hours`). Daarna tonen de sites en de presentatie de **Eindstand**, bevroren op de laatste meting vóór de deadline.
4. **Deadline wijzigen** kan zolang hij loopt (binnen die 8 uur). **Stop finale nu** beëindigt hem meteen (Eindstand vanaf nu). **Annuleer finale** stopt zonder Eindstand; ook achteraf, als de Eindstand weg moet.

Alles staat in de privétab `finale` en in het activiteitenlog (wie en wanneer). De openbare site leest een kopie zonder namen (openbare tab `finale`). De budgetlimiet, het één-run-per-tijdvak en alle andere regels blijven gelden; de collector controleert bij elke run zelf of er echt een finale loopt.

**Herinnering:** vanaf 3 dagen voor `campaign.end_date` staat bovenaan de beheerpagina *"De campagne eindigt op … Vergeet niet de finale te starten voor de laatste les."*, tot er een finale heeft gelopen (`finale.remind_days_before_end`).

### Installatie, stap voor stap

Eenmalig, ca. 20 minuten. Je plakt nergens sleutels in de repo: alles gaat via GitHub-secrets.

**1. Cloudflare-account**
1. Maak een gratis account op <https://dash.cloudflare.com/sign-up> en bevestig je e-mail.

**2. Zero Trust (voor Access) aanzetten**
1. Klik in het Cloudflare-dashboard links op **Zero Trust**.
2. Kies een **teamnaam** (bijv. `tiktokklas`). Je teamdomein wordt dan `https://tiktokklas.cloudflareaccess.com`; dat heb je bij stap 7 nodig.
3. Kies het **Free**-abonnement (gratis tot 50 gebruikers). Cloudflare kan om betaalgegevens vragen; er wordt niets afgeschreven op Free.
4. Controleer onder **Settings → Authentication → Login methods** dat **One-time PIN** aan staat (standaard aan).

**3. Cloudflare API-token en account-id (voor het automatisch uitrollen)**
1. Rechtsboven: profiel-icoon → **My Profile → API Tokens → Create Token**.
2. Kies het sjabloon **Edit Cloudflare Workers** → **Use template**.
3. *Account Resources*: jouw account. *Zone Resources*: **All zones** (je hebt geen eigen domein nodig). → **Continue to summary → Create Token**. Kopieer het token (je ziet het maar één keer).
4. Je **Account ID** staat op de pagina **Workers & Pages** (rechts, *Account details*) of in de adresbalk na `dash.cloudflare.com/`.

**4. GitHub-token voor *Nu verversen* (fine-grained)**
1. GitHub → je profielfoto → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. *Token name*: `tiktok-beheer`. *Expiration*: tot na de campagne (bijv. 30 november 2026).
3. *Resource owner*: `bindro1234`. *Repository access*: **Only select repositories** → `TiktokDashboard`.
4. *Permissions → Repository permissions → **Actions: Read and write***. (Metadata: read-only gaat automatisch.) Verder niets.
5. **Generate token** en kopieer het. Dit token kan alleen workflows in deze ene repo starten en bekijken.

**5. GitHub-secrets toevoegen**
Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Waarde |
|---|---|
| `CLOUDFLARE_API_TOKEN` | token uit stap 3 |
| `CLOUDFLARE_ACCOUNT_ID` | account-id uit stap 3 |
| `GH_DISPATCH_TOKEN` | token uit stap 4 |
| `GOOGLE_SERVICE_ACCOUNT_B64` | staat er al (zelfde service-account; dat moet Editor zijn op de privésheet) |

**6. Eerste keer uitrollen**
1. **Actions → Deploy private dashboard → Run workflow** (of merge een PR die `private/` wijzigt).
2. Aan het eind staat de Worker op `https://tiktok-beheer.<jouw-subdomein>.workers.dev` (het adres staat in de log van de stap *Deploy Worker*, en onder **Workers & Pages → tiktok-beheer**).
3. Open je dat adres nu, dan zie je **Geen toegang**: de pagina is dicht tot Access is ingesteld. Dat is de bedoeling.

**7. Access ervoor zetten (e-maillijst)**
1. Cloudflare → **Workers & Pages → tiktok-beheer → Settings → Domains & Routes**. Klik bij **workers.dev** op **Enable Cloudflare Access** (en zet *Preview URLs* uit als die aan staan).
2. Klik op **Manage Cloudflare Access**. Je komt bij de Access-applicatie van de Worker.
   - Werkt dat niet: **Zero Trust → Access → Applications → Add an application → Self-hosted**, domein `tiktok-beheer.<jouw-subdomein>.workers.dev`.
3. Bij **Policies**: een policy met *Action* **Allow** en bij *Include* **Emails** → vul de e-mailadressen van alle docenten in. (Toevoegen of weghalen kan later altijd hier.)
4. Kopieer bij de applicatie (tab *Overview* / *Basic information*) de **Application Audience (AUD) Tag**.
5. Voeg twee GitHub-secrets toe:
   - `ACCESS_TEAM_DOMAIN`: je teamdomein uit stap 2, bijv. `https://tiktokklas.cloudflareaccess.com` (te vinden onder **Zero Trust → Settings → Custom Pages → Team domain**);
   - `ACCESS_AUD`: de AUD-tag.
6. Draai **Deploy private dashboard** nog een keer (zet de nieuwe secrets in de Worker).

**8. Testen**
1. Open het workers.dev-adres. Vul je e-mail in, je krijgt een code per mail, en je bent binnen.
2. Probeer met een adres dat níét op de lijst staat: dat krijgt geen code.
3. Kijk op **Beheer** bij *Activiteit*: daar staat je bezoek.

### Hoe het werkt

- `private/src/worker.js`: de Worker. Elk verzoek, ook voor de pagina zelf, gaat eerst door de Access-controle (`private/src/access.js`). Schrijven kan alleen met een geldige herkomst en een eigen header (tegen CSRF).
- Leerling toevoegen gebruikt dezelfde handle-regels als de collector (`tests/handle_cases.json` test beide). Dubbele handles worden geweigerd.
- *Nu verversen* start de workflow **Nu verversen** via de GitHub-API, maar alleen als de laatste profielrun minstens 30 minuten geleden is en er geen verversing loopt. De collector controleert dat daarna nog een keer.
- De **reservetimer** (`scheduled` in `private/src/worker.js`) leest alleen `run_log` en start de collector als een tijdvak openstaat en nog niet gedraaid heeft; zie *Schema*.
- `private/build.sh` zet de instellingen uit `config.yaml` klaar en kopieert de presentatiemodus van `site/`. Tests: `node --test "private/test/*.test.mjs"` en `node tools/private_check.mjs` (met nepnamen).

## Eenmalige installatie

1. **Secrets** (Settings → Secrets and variables → Actions): `BRIGHTDATA_API_KEY` en `GOOGLE_SERVICE_ACCOUNT_B64`.
2. Deel **beide** sheets met het service-account als Editor.
3. **Openbare sheet publiceren:** Bestand → Delen → Publiceren op internet → Hele document, CSV → Publiceren. (Alleen de openbare sheet!)
4. **GitHub Pages:** Settings → Pages → Source: *GitHub Actions*. De workflow *Deploy website* zet `site/` online bij elke wijziging op `main`.
5. Geplande workflows draaien alleen vanaf de standaardbranch (`main`).

## Website

Statische site in `site/` (HTML + Chart.js). Leest de gepubliceerde CSV's van `handles`, `history`, `posts_latest` en `finale`, en ververst zichzelf elke 10 minuten (tijdens een finale elke 2 minuten). `post_history` wordt alleen geladen voor *Video's* en accountpagina's.

- **Stand**: ranglijst op totaal weergaven, met `+ 24 uur` (vergeleken met de meting van 24 uur eerder; met runs elke 2 uur schuift dat mee en springt het niet terug om middernacht), stijgers/dalers (▲▼) en een label *privé* voor accounts die op privé staan. Klik op **Weergaven, Volgers, Posts of Likes** om daarop te sorteren (hoog → laag); nog een keer klikken draait de volgorde om. Het nummer blijft de echte plaats in de stand. Op een telefoon kies je dit met *Sorteer op*.
- **Grafiek**: tot 8 accounts tegelijk over tijd; wissel tussen weergaven, volgers, posts en likes, en tussen **Alles / 7 dagen / 48 uur** (met 12 metingen per dag zie je zo het verloop binnen een dag; bij korte periodes staan er ook uren op de as). Overige accounts kunnen grijs erbij.
- **Groei**: erbij per dag of per week (per dag = laatste meting van die dag min die van de dag ervoor), plus de grootste stijgers.
- **Video's**: *Snelste stijgers*, de video's met de meeste nieuwe weergaven in de laatste 2, 6 of 24 uur.
- **Hashtags**: de meest gebruikte hashtags en de hashtags met de meeste weergaven (van campagneposts), met het aantal accounts. Klik op een hashtag om te zien welke accounts hem gebruiken.
- **Account**: klik op een account voor details, de eigen hashtags, **weergaven per video over tijd** (de snelste stijger van de laatste 24 uur in oranje) en alle posts.
- **Finale**: bovenaan een aftelklok met LIVE; na de deadline *Eindstand* boven de stand.
- Knop **▶ Presentatie** rechtsboven: opent de presentatiemodus in een nieuw tabblad.

**Snelheid** (getest met 4× langzamere processor en 10 Mbit/s, met data van het einde van de campagne): presentatie eerste dia ≈ 1,8 s, verversen ≈ 1,2 s; site ≈ 1,7 s. De presentatie laadt `post_history` nooit. Het tabblad *Video's* laadt het wel: aan het eind van de campagne ≈ 5–6 MB, ≈ 7 s de eerste keer (daarna 10 minuten in het geheugen). Wordt dat te traag, dan kan de collector een klein voorberekend tabblad (`video_trends`) schrijven.

**Na het toevoegen van een nieuw openbaar tabblad** (nu `post_history` en `finale`): draai eenmalig **Actions → Collect TikTok stats → `setup`** (geen dry-run). Die maakt de tabbladen aan en zet in de samenvatting hun `gid`; die horen in `site/config.js` onder `gids`.

De site leest de CSV via de "Publiceren op internet"-link: `publishedId` in `site/config.js` is het deel van die link dat met `2PACX-` begint. Publiceer je de sheet opnieuw en verandert de link, pas het dan daar aan. De workflow *Check website* controleert na elke deploy of de links en de site werken, ook de presentatiemodus op 1920×1080 en 1280×720.
