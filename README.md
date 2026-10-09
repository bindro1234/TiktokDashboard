# TikTok-campagne tracker

Houdt de statistieken van de klas bij tijdens de Social Media Campagne (28 sept – 30 okt 2026) en toont de stand op een website. De campagne liep eerst op TikTok en is rond 7 okt verhuisd naar **Instagram** (posts, carrousels en reels); beide platforms worden opgehaald.

```
Bright Data (TikTok- en Instagram-scraper)  →  GitHub Actions (collector/)  →  Google Sheets  →  website (site/, GitHub Pages, alleen handles)
                                                                              ↘  beheerpagina (private/, Cloudflare, met namen, achter inlog)
```

- **TikTok-profielen** worden **elke 12 uur** opgehaald (08:00 en 20:00 Nederlandse tijd), **Instagram-profielen elke 4 uur** (00:00, 04:00, …, 20:00). Eén profiel kost 1 record; het TikTok-profiel bevat de statistieken van de ~16 nieuwste video's, het Instagram-profiel de 12 nieuwste posts (zie *Instagram ophalen*). Hoe vaak per platform staat onder `frequency` in `config.yaml` (vaste stappen, zie *Schema*). Tijdens een **finale** (zie *Beheerpagina*) elke 15 minuten.
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
| privé | `accounts` | `student_name`, `tiktok_handle`, `active` (ja/nee), optioneel `main_account` (alleen bij een tweede account: de handle van het hoofdaccount) en optioneel `instagram_handle` (het ene Instagram-account van de leerling, zie *Instagram-handles*) — **dit vul je zelf in** |
| privé | `run_log` | per run: tijd, type (`profiles`, `force_refresh`, `today_check`, `posts_refresh`, … voor TikTok; `ig_profiles`, `ig_force_refresh`, `ig_today_check` voor Instagram), venster, dry-run, verwachte en echte records, fouten, status, notities |
| privé | `profile_window` | per account: hoeveel video's het profiel teruggaf en de oudste datum daarvan (voor de weekrefresh) |
| privé | `activity_log` | wie (e-mail) wat deed op de beheerpagina en wanneer: geopend (1× per dag), nu verversen, leerling toegevoegd/(de)geactiveerd, finale gestart/gewijzigd/gestopt, export. Wordt vanzelf aangemaakt |
| privé | `finale` | per finale: start, wie, deadline, status (`active`, `stopped` = vroeg gestopt, `cancelled` = geannuleerd), wanneer gestopt en door wie. De laatste rij telt |
| privé | `dagopdrachten` | per dagopdracht: `date`, `min_posts`, `label`, `active` (verwijderen = `nee`, rijen blijven staan), wanneer en door wie gewijzigd. Wordt vanzelf aangemaakt op Beheer |
| openbaar | `handles` | actieve handles, privé ja/nee, laatste status, en `status_since`: sinds wanneer die status (ok / privé / niet gevonden) geldt, en `group`: de handle van het hoofdaccount (bij één account de eigen handle; zie *Twee accounts*) |
| openbaar | `outliers` | *buiten schaal*: `handle`, `buiten_schaal` (ja/nee), `updated_at`. Alleen handles. Heeft een vaste `gid` (702500001), zodat de site hem zonder extra stap vindt (de `ig_*`-tabbladen hebben ook vaste gids, 702500002 t/m 702500006) |
| openbaar | `profile_snapshots` | volgers, volgend, likes, aantal video's per run |
| openbaar | `posts_latest` | één rij per video (`video_id`), steeds bijgewerkt met de nieuwste cijfers, plus `hashtags`, `missing_since` en `hist_*` (laatste `post_history`-rij) |
| openbaar | `history` | per run per account: totaal weergaven, volgers, likes en posts in de campagne (voor de grafieken) |
| openbaar | `post_history` | per video over tijd: `video_id`, `handle`, `timestamp`, `views`, `likes` (licht gehouden, zie boven) |
| openbaar | `ig_handles` | actieve Instagram-handles: privé ja/nee, volgers, laatste status (ok / privé / fout) en `status_since`. Geen groepen en geen koppeling met TikTok |
| openbaar | `ig_history` | per run per account: volgers, volgend, aantal posts, privé ja/nee en het aantal posts in de campagne |
| openbaar | `ig_posts` | één rij per post (`post_id`): handle, tijdstip, type (`photo`, `carousel`, `reel`), hashtags, link, eerste en laatste keer gezien |
| openbaar | `ig_baseline` | per account de eerste geslaagde meting van de volgers (de basislijn voor de ranglijst); wordt alleen aangevuld, nooit aangepast |
| openbaar | `ig_outliers` | *buiten schaal* voor Instagram (komt in een latere stap in gebruik) |
| openbaar | `finale` | kopie van de huidige finale zonder namen of e-mail: start, deadline, status, gestopt (voor de aftelklok en de Eindstand op de openbare site) |

### Accounts toevoegen

Zet in `accounts` per leerling een rij. De handle mag in elke vorm: `@naam`, `naam`, `https://www.tiktok.com/@naam`, met hoofdletters of spaties. Ongeldige handles (bijv. een korte `vm.tiktok.com`-link) worden overgeslagen en gemeld in `run_log`; de run gaat gewoon door. Zet `active` op `nee` om een account niet meer te volgen (leeg = ja).

### Instagram-handles

Sinds de campagne van TikTok naar Instagram is verhuisd (rond 7 okt) heeft elke leerling ook één Instagram-account, in de kolom `instagram_handle` van `accounts` (eerst typte je die als `Insta `; `python -m collector setup` hernoemt de kop vanzelf, en tot die tijd worden beide namen gelezen).

- **Elke vorm mag**, net als bij TikTok: `naam`, `@Naam`, `instagram.com/naam`, een profiellink met `?igsh=…`, of een link als `instagram.com/naam/reel/…`. Instagram heeft eigen regels: 1–30 tekens (letters, cijfers, `_` en `.`), niet eindigend op een punt en zonder twee punten achter elkaar. Een link naar een **post** (`/p/…`, `/reel/…`) of een andere pagina wordt geweigerd: dat is geen profiel. Dezelfde regels staan in `collector/handles.py` en `private/public/lib.js`; `tests/handle_cases.json` test beide.
- **Eén Instagram-account per leerling**, los van de TikTok-handle (sommige leerlingen gebruiken op beide dezelfde naam). Hij staat op de **eerste rij** van de leerling; een handle op de rij van een tweede TikTok-account wordt genegeerd en gemeld. Twee leerlingen met dezelfde Instagram-handle: de tweede wordt overgeslagen en gemeld. Een leerling met alléén Instagram heeft een rij zonder `tiktok_handle`; dat is geen fout.
- **Beheer**: in *Leerling toevoegen* staat een veld *Instagram-handle* (vul minstens één van de twee handles in). In *Alle leerlingen* staat een kolom Instagram met **+ Instagram** / **Wijzig** (leeg opslaan of *Verwijderen* haalt hem weg; de rij blijft staan). Het blok **Leerlingen zonder Instagram** toont alle actieve leerlingen zonder (geldige) handle, met een invoerveld per leerling. Elke wijziging komt in het activiteitenlog (*instagram-handle toegevoegd / gewijzigd / verwijderd*). Ongeldige of dubbele handles staan onder *Problemen in accounts*.
- Overal waar een account wordt aangeduid, hoort het platform erbij (`tiktok` of `instagram`): dezelfde naam op beide platforms is twee verschillende accounts.
- Het ophalen staat onder *Instagram ophalen*.

### Twee accounts per leerling

Sommige leerlingen hebben twee accounts (bijv. één voor hun merk en één voor reclame en alles wat daar niet bij past). Voeg het tweede account toe via **Beheer → Alle leerlingen → + account** bij de leerling, of zet zelf een rij in `accounts` met dezelfde naam en in `main_account` de handle van het hoofdaccount. Het hoofdaccount zelf laat `main_account` leeg.

- **Overal samengeteld**: weergaven, volgers, posts en likes van beide accounts tellen op tot één leerling (stand, grafieken, Export, mediaan, presentatie). Bij gedeeltelijke runs telt per account steeds de laatste meting.
- **Uitsplitsen**: in **Overzicht** en de **Leerlingen**-kalender opent ▸ *2 accounts* een rij per account; op de leerlingpagina kies je *beide accounts samen* of *alleen @…*. Op de openbare site hetzelfde: ▸ in de stand en een keuzemenu op de accountpagina.
- **Reeks en kalender**: een dag is blauw (gepost) als **één van beide** accounts iets postte. *Vandaag*, *Controleer nu* (haalt de openbare accounts op van wie nog niet gepost heeft, op TikTok en Instagram), dagopdrachten en *X dagen geen post* werken ook per leerling. *Privé* en *niet gevonden* worden per account gemeld, met de handle erbij.
- Is het hoofdaccount niet (meer) actief, of zelf een tweede account, dan telt het tweede account apart en staat er een melding op Beheer (*telt apart*).
- **Let op, openbaar:** de kolom `group` in de openbare tab `handles` laat zien dat twee handles bij dezelfde deelnemer horen (zonder naam). De openbare site toont ze samen als `@merk + @reclame`. Op de openbare site gebeurt het samenvoegen pas na de volgende ophaalrun; op de beheerpagina meteen.
- **Kosten:** elk extra account is een extra profiel per run: ≈ 12 records per dag, ≈ 360 per maand.

## Instagram ophalen

Een profielrecord per account (**1 record per account per run**; ook een privé account of een account dat niet bestaat kost 1 record) bevat het aantal volgers en gevolgden, het aantal posts, privé ja/nee en de **12 nieuwste posts** (vastgezette posts staan vooraan) met id, link, type en onderschrift. Per post bewaren we `post_id`, link, tijdstip, type (`photo`, `carousel`, `reel`) en de hashtags uit het onderschrift.

- **Alleen posts van `instagram.start_date` (7 okt) t/m 30 okt tellen**; eerdere posts worden nooit opgeslagen.
- **Niet in het record, dus niet in de tabbladen:** likes, reacties en weergaven per post (bewust weggelaten in plaats van lege kolommen), **stories** (er is geen scraper voor; ze worden niet meegeteld) en hashtags in reacties of in de bio. Alleen hashtags uit het onderschrift zijn te zien.
- **Tijdstip van een post:** het record noemt alleen een datum, en die is bij ongeveer 1 post op de 10 een dag verkeerd. Het tijdstip komt daarom uit het **post-id**: Instagram-id's bevatten het moment van maken (milliseconden sinds 24 aug 2011, 23 bits naar links). Een ingeplande post (aangemaakt vóór hij gepubliceerd wordt) telt hoogstens vanaf de genoemde datum; zonder bruikbaar id geldt de datum zelf.
- **Venster van 12 posts:** wie tussen twee runs meer dan ongeveer 9 posts plaatst, mist er een. De run meldt dat in de notities (*post list full (12) without overlap with stored posts*).
- **Verdwenen posts** blijven in `ig_posts` staan en tellen dus nog mee voor de dag waarop ze geplaatst zijn.
- **Privé en niet gevonden:** dezelfde meldingen als bij TikTok (`last_status` in `ig_handles`: ok / privé / fout, met `status_since`); op de beheerpagina komen ze in stap 3 bij de waarschuwingen.
- **Basislijn:** de eerste geslaagde meting van de volgers per account komt in `ig_baseline` en wordt nooit meer aangepast (de ranglijst telt de volgers erbij sinds die meting). Een later toegevoegd account krijgt zijn basislijn bij zijn eigen eerste meting.
- **Eigen run-types** in `run_log` (`ig_profiles`, `ig_force_refresh`, `ig_today_check`) en eigen vensters (`2026-10-12/ig-08u`): een TikTok-run en een Instagram-run laten elkaars tijdvak nooit overslaan, maar tellen wel voor **dezelfde maandlimiet**. De "net ververst"-regel en de 30-minutengrens van *Nu verversen* gelden per platform.
- **Tabbladen** (alleen handles, geen namen; niets in de openbare sheet verbindt iemands TikTok- en Instagram-account): `ig_handles`, `ig_history`, `ig_posts`, `ig_baseline` en `ig_outliers`, zie *Tabbladen*. Ze krijgen vaste `gid`s en worden aangemaakt door `setup` of door de eerste Instagram-run.
- **Proberen kost niets:** `python -m collector ig-profiles --dry-run` (of in GitHub *Collect TikTok stats → `ig-profiles`* met dry-run aan) toont welke accounts opgehaald zouden worden en wat het kost, zonder iets op te halen of aan te maken.

## Kosten en budget

- Bright Data rekent per record: 1 profiel = 1 record, 1 post = 1 record. 5.000 records per kalendermaand zijn gratis, daarna ca. $1,50 per 1.000.
- **Harde limiet:** `budget.monthly_cap` in `config.yaml` (nu **23.000**; boven de gratis 5.000 is het pay-as-you-go). Vóór elke run telt de collector de records van deze maand op uit `run_log` en weigert de run (status `refused`) als het totaal boven de limiet zou komen. Ook elke finale-run.
- **De telling klopt met de rekening:** vóór elke run vergelijkt de collector `run_log` met het aantal rijen dat Bright Data zelf voor deze maand heeft gefactureerd (`/customer/bw`, in `status` te zien). Is dat hoger (een job die nooit gelogd is, een test met de hand), dan telt het verschil mee als een rij `billing_adjustment` in `run_log`; de limiet zit dus nooit onder wat echt gefactureerd wordt. Het telt alleen omhoog, nooit omlaag. Is het niet te lezen (bijv. geen rechten voor de sleutel), dan staat er *billing check unavailable* in de notities en telt `run_log` alleen, zoals eerder.
- Vóór een weekrefresh of controle wordt ook budget **gereserveerd** voor alle profielruns die deze maand nog komen (TikTok en Instagram samen), zodat de hoofdbronnen nooit zonder budget komen te zitten.
- De weekrefresh haalt maximaal `posts_refresh.num_of_posts` posts per account op (nu **40**). Dat is ook de bovengrens die de dry-run gebruikt en die wordt gereserveerd.
- **Schatting tot 30 oktober** (stand 9 okt: ≈ 5.850 records verbruikt; TikTok 61 accounts elke 12 uur, Instagram elke 4 uur; `python -m collector status` toont de actuele cijfers):

  | | 23 Instagram-accounts (nu) | 52 Instagram-accounts (hele klas) |
  |---|---|---|
  | al verbruikt (9 okt) | ≈ 5.850 | ≈ 5.850 |
  | TikTok-profielruns (43 runs × 61) | ≈ 2.620 | ≈ 2.620 |
  | Instagram-profielruns (128 runs) | ≈ 2.940 | ≈ 6.660 |
  | weekrefreshes (3 vrijdagen, verbruik ≈ 10–60 per keer) | ≈ 150 | ≈ 150 |
  | Nu verversen (≈ 5×, beide platforms) | ≈ 420 | ≈ 570 |
  | Controleer nu (Vandaag, ≈ 15× een deel van de klas, TikTok en Instagram) | ≈ 600 | ≈ 600 |
  | **totaal zonder finale** | **≈ 12.600** | **≈ 16.500** |
  | finale van 8 uur, het maximum (32 runs × alle accounts van beide platforms) | +2.700 | +3.600 |

  Kosten: ca. $1,50 per 1.000 records boven de gratis 5.000, dus (totaal − 5.000) × $1,50 / 1.000: bij 12.600 ≈ $11, bij 16.500 met finale ≈ $23.
- **Waarom 23.000:** een weekrefresh reserveert vooraf alle resterende profielruns van de maand (beide platforms) plus max. 40 posts per account. Zelfs met de hele klas op Instagram en een finale van 8 uur blijft het verwachte verbruik (≈ 20.100) onder de limiet; de rest is ruimte voor *Controleer nu*-checks en extra verversingen. De limiet is een bovengrens, geen verbruik: betaald wordt alleen wat echt wordt opgehaald.

## Schema

GitHub-cron draait in UTC en is vaak 5–30 minuten te laat of slaat soms een keer over (en bij een nieuwe repo soms urenlang alles). Daarom start de workflow meerdere keren per tijdvak, en kijkt de collector zelf naar de Nederlandse tijd en `run_log`: elk tijdvak draait precies één keer, en een mislukte poging wordt bij de volgende start opnieuw geprobeerd (maximaal 2 keer). Zomer- en wintertijd gaan zo vanzelf goed.

| Run | Tijdvak (Amsterdam) |
|---|---|
| Profielen TikTok | `frequency.tiktok` (nu `12h`): 08:00–08:59 en 20:00–20:59 |
| Profielen Instagram | `frequency.instagram` (nu `4h`): 00:00–00:59, 04:00–04:59, …, 20:00–20:59 (6 per dag) |
| Weekrefresh | vrijdag 08:30 – 10:00 |
| Eenmalige controle | 5 okt, direct na de run van 22:00 |
| Finale | alleen als je hem start op de beheerpagina: elke 15 minuten tot de deadline, voor TikTok én Instagram |
| Controle *Vandaag* | alleen als je op de beheerpagina op **Controleer nu** klikt: alleen wie vandaag nog niet gepost heeft, TikTok én Instagram (eerst TikTok, dan Instagram) |

**Frequentie per platform.** Onder `frequency` in `config.yaml` kiest elk platform een vaste stap: `off`, `daily` (16:00), `12h` (08:00, 20:00), `6h` (02:00, 08:00, 14:00, 20:00), `4h` (00:00, 04:00, …, 20:00) of `2h` (alle 12 vensters van `schedule.profile_runs`). Elke stap is een deel van die 12 uurvensters, dus de runs sluiten altijd aan op de uurlijkse crons; de test `test_crons_cover_every_window` controleert alle 12. Een TikTok-venster heet `2026-10-12/08u`, een Instagram-venster `2026-10-12/ig-08u`. De collector, de reservetimer van de Worker en de budgetreservering lezen dezelfde vensters.

**Twee timers.** GitHub-cron (`collect.yml`) vuurt elk uur om :10, :30 en :50. Omdat die niet betrouwbaar is, heeft de beheerpagina-Worker een eigen *Cron Trigger* (`[triggers]` in `private/wrangler.toml`): **elke 5 minuten**. Die kijkt naar de tijdvakken van beide platforms uit `config.yaml`, naar een lopende finale (tab `finale` in de privésheet) en naar `run_log`. Staat er een tijdvak of een finale-run open die nog niet gedraaid heeft, en loopt de collector nog niet, dan start de Worker *Collect TikTok stats* met `auto` (via `GH_DISPATCH_TOKEN`). De collector controleert dat daarna zelf nog een keer. Starten ze allebei, dan doet de tweede niets en kost niets: elk tijdvak draait maar één keer. Zomer- en wintertijd: beide timers vuren elk uur, dus ook de dag van de klokwissel (25 okt) gaat goed; de tests controleren dat voor beide. Wat de timer deed staat in de Worker-logs (Cloudflare → Workers & Pages → tiktok-beheer → Logs).

**Net ververst?** Een geplande profielrun wordt overgeslagen (status `skipped`, 0 records) als er minder dan 60 minuten eerder al een echte profielrun **van hetzelfde platform** was, bijvoorbeeld via *Nu verversen* om 07:45 (dan vervalt de TikTok-run van 08:00; de volgende is om 20:00). Een TikTok-run laat dus nooit een Instagram-run overslaan, of andersom. Finale-runs worden nooit overgeslagen. Instelbaar via `schedule.skip_if_profiles_ran_within_minutes`. Een controle via *Vandaag* (`today_check` in `run_log`) telt hier **niet** mee: die haalt maar een deel van de klas op, dus de volgende geplande run gaat gewoon door.

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
| `profiles` | TikTok-profielen nu ophalen (zonder 30-minutengrens) |
| `ig-profiles` | Instagram-profielen nu ophalen; met dry-run aan zie je alleen wat het zou kosten |
| `refresh` | weekrefresh nu |
| `check` | eenmalige controle nu (optioneel eigen lijst handles) |
| `today` | *Controleer nu* van het tabblad Vandaag: profielen van alleen de opgegeven handles (veld *handles*, met komma's; Instagram met het platform ervoor: `instagram:naam`, een kale naam is TikTok). Eén run voor de TikTok-handles en daarna één voor de Instagram-handles; gaat er één mis, dan loopt de andere toch en wordt de workflow rood. Normaal start de beheerpagina dit |
| `auto` | wat een geplande run ook doet |
| `setup` | tabbladen en kopregels aanmaken (veilig om opnieuw te draaien) |

Lokaal (Python 3.11):

```bash
pip install -r requirements.txt
export GOOGLE_SERVICE_ACCOUNT_B64=...   # base64 van de service-account-JSON
export BRIGHTDATA_API_KEY=...           # zet dit NOOIT in een bestand in de repo
python -m collector status
python -m collector profiles --dry-run
python -m collector ig-profiles --dry-run
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
- Testen hoe de finale eruitziet kan met `?nu=2026-10-30T15:30` (doet alsof het dat moment is, alleen in jouw browser).
- Instellen in `site/config.js` onder `present`: seconden per dia (`slideSeconds`), accounts per pagina (`pageSize`), accounts in de grafiek (`graphAccounts`, max. 8) en rijen bij de stijgers (`risers`). Tijdelijk een andere snelheid: `?present&sec=20`.

## Nu verversen (alleen beheerder)

Extra profielrun buiten het schema, bijvoorbeeld vlak voor de les, voor **TikTok en Instagram**: elk platform met een eigen run in `run_log` (`force_refresh` en `ig_force_refresh`) en een eigen 30-minutengrens.

1. Open de **privé-site** (achter Cloudflare Access) en ga naar **Beheer**. Klik op **↻ Nu verversen**. Nieuwe cijfers staan binnen ~5–7 minuten op beide sites.
2. Alternatief zonder privé-site: op GitHub onder **Actions → Nu verversen → Run workflow** (alleen met schrijfrechten op deze repo).

De openbare site heeft geen beheerdersknop meer (de oude `?beheerder`-link doet niets meer).

Beveiliging en kosten:

- De openbare site bevat **geen tokens of sleutels** en geen beheerfuncties. De privé-site start de workflow via de Worker, die de Access-login zelf controleert.
- Een run haalt alle actieve profielen op (1 record per account, beide platforms) en valt onder dezelfde **maandlimiet**.
- **Dubbel tikken kost niets extra:** was de laatste echte profielrun van dat platform (gepland of handmatig) minder dan 30 minuten geleden, dan wordt die run geweigerd en als `refused` gelogd in `run_log` (instelbaar via `force_refresh.min_minutes_between` in `config.yaml`). Loopt er net een geplande run, dan wacht de workflow daarop en wordt hij daarna geweigerd.

## Beheerpagina (privé, met namen)

Een aparte website voor docenten, op Cloudflare (gratis), achter **Cloudflare Access**: alleen e-mailadressen op de lijst komen erin, met een eenmalige code per mail (geen wachtwoorden). Iedereen op de lijst ziet alles. De code staat in `private/`; de Worker leest en schrijft de privésheet live met het service-account en controleert zelf bij elk verzoek het Access-token (handtekening, AUD, uitgever, verloopdatum). Zonder geldig token: *Geen toegang*.

| Tabblad | Wat |
|---|---|
| **Overzicht** | bij twee accounts staat er `@merk + @reclame` met ▸ *2 accounts* om ze apart te zien (zie *Twee accounts*). Bovenaan **Actie nodig**: wie vandaag nog niet gepost heeft, privé, niet gevonden en dagopdracht niet gehaald, elk met een link naar de leerling. Daaronder alle gevolgde leerlingen met naam en handle, sorteerbaar, met waarschuwingen: *privé*, *niet gevonden*, *nog niet opgehaald*, *X dagen geen post* (2 of meer, vrije dagen tellen niet mee), *video verdwenen*, *opdracht 2 okt: 3/5*. **Klik op een waarschuwing** voor de details: welke video verdwenen is en sinds wanneer, sinds wanneer een account privé of niet gevonden is. De kaart *Weergaven* toont naast het totaal de **mediaan per leerling**. Geen naam ingevuld = <mark>onbekend</mark>. Na een finale: *Eindstand* |
| **Vandaag** | wie vandaag nog niet gepost heeft en wie wel (op TikTok of Instagram, met tijd, platform en link naar de post), plus *laatst gecontroleerd* per platform, en de knop **Controleer nu** (zie hieronder) |
| **Leerlingen** | kalender per campagnedag (Nederlandse tijd): gepost / gemist / vrij / nog niet, met reeks, gemiste dagen en **opdrachten niet gehaald** (zie *Vrije dagen* en *Dagopdrachten* hieronder). Klik voor details: gemiste dagen, huidige en langste reeks, dagopdrachten, gem. weergaven per post, **mediaan per video** (de gewone video: één virale video trekt het gemiddelde omhoog, de mediaan nauwelijks), beste video (link), engagement = (likes + reacties + gedeeld) / weergaven, hashtags, **weergaven per video over tijd** (snelste stijger gemarkeerd) en alle posts (TikTok), de **Instagram-posts** en de Instagram-volgers (zie *TikTok en Instagram samen*) |
| **Stijgers** | de video's met de meeste nieuwe weergaven in de laatste 2, 6 of 24 uur, met naam. Met *zonder buiten schaal* |
| **Hashtags** | meest gebruikt en meeste weergaven, met wie ze gebruikt. Met *zonder buiten schaal* |
| **Opvallend** | video's en accounts om even naar te kijken (zie hieronder) |
| **Presentatie** | de presentatiemodus, met voornamen erbij (alleen hier); ook met pauze, aftelklok en Eindstand |
| **Beheer** | **Finale** (zie hieronder), *Nu verversen* (zelfde 30-minutengrens), **Dagopdrachten**, leerling toevoegen (met optionele Instagram-handle), **Instagram-handles** toevoegen of wijzigen en de lijst *Leerlingen zonder Instagram*, **+ account** (tweede account bij een leerling), leerlingen (de)activeren (nooit verwijderen: `active` wordt `nee`), **buiten schaal** per leerling, budget t.o.v. de limiet, schema, laatste runs en fouten, ongeldige/dubbele handles, activiteitenlog |
| **Export** | CSV voor de beoordeling (Excel NL of standaard), één rij per leerling, ook met `opdrachten_niet_gehaald`, `mediaan_weergaven_per_video` en de Instagram-kolommen (zie *TikTok en Instagram samen*) |

Limiet en schema staan alleen in `config.yaml`; de beheerpagina toont ze (ze worden bij elke deploy meegenomen).

### Vrije dagen (weekenden en vakantie)

Op vrije dagen hoeft niemand te posten. Ze staan in `config.yaml` onder `campaign.off_days`: nu alle **weekenden** en de **Herfstvakantie (ma 19 t/m vr 23 oktober)**.

- **Wel gepost op een vrije dag:** telt gewoon mee (posts, weergaven) en verlengt de **reeks**.
- **Niet gepost op een vrije dag:** geen *gemiste dag*, de reeks blijft staan, en de dag telt niet mee voor de waarschuwing *X dagen geen post*. Voorbeeld: vrijdag gepost, dan zaterdag t/m maandag niets = geen waarschuwing; pas als ook dinsdag voorbij is zonder post.
- In de kalender zijn vrije dagen **grijs** (*vrij*); met een post krijgen ze gewoon de blauwe kleur. Met de muis erop staat waarom de dag vrij is.
- Alleen de privé-site gebruikt dit (reeks, gemiste dagen, waarschuwingen, Export). Het ophalen van cijfers loopt op vrije dagen gewoon door.
- Een extra vrije periode toevoegen: nog een regel onder `periods`, bijv. `- {name: Studiedag, from: 2026-10-09, to: 2026-10-09}`. Na de merge zet de deploy het vanzelf in de privé-site.

### Vandaag en *Controleer nu*

Sommige docenten laten leerlingen eerder gaan als hun video van vandaag online staat. Het tabblad **Vandaag** toont twee lijsten: *nog niet gepost* en *gepost* (met tijd en link naar de video), plus *laatst gecontroleerd* (de laatste ophaalrun). Op een dag met een dagopdracht staat er bijv. **2/5** in plaats van een vinkje, en is iemand pas klaar bij het minimum. Privé-accounts staan apart onder *kan niet gecontroleerd worden (privé)*.

- **Controleer nu** haalt meteen de profielen op van alleen de actieve, openbare accounts die vandaag nog niet (genoeg) gepost hebben, **op TikTok en op Instagram** (ook van een leerling met alleen Instagram). Wie op één van beide platforms gepost heeft, is klaar en wordt op geen van beide opgehaald. 1 record per account: hoe korter de lijst, hoe goedkoper. Vóór het starten zie je wat het kost, met de verdeling (bijv. *18 accounts, 18 records (12 TikTok, 6 Instagram)*).
- Het duurt ongeveer **5–7 minuten per platform** (TikTok en Instagram na elkaar, dus tot ≈ 10 minuten) voordat de nieuwe cijfers er staan; het tabblad ververst vanzelf als de run klaar is.
- Regels: maximaal één keer per **10 minuten** (`today_check.cooldown_minutes`), niet terwijl er al een ophaalrun loopt, en alleen als het binnen de maandlimiet past (met de resterende geplande runs van de maand gereserveerd). De lijst wordt op de server gemaakt, niet in de browser.
- Eigen run-types in `run_log`: `today_check` (TikTok) en `ig_today_check` (Instagram). Die tellen niet als volledige profielrun, dus de volgende geplande run wordt er niet door overgeslagen (per platform). Zo'n gedeeltelijke run werkt alleen de opgehaalde accounts bij (posts, status) en schrijft alleen voor hen een rij in `history`; de rest blijft precies zoals het was.

### TikTok en Instagram samen

Op de privé-site tellen TikTok en Instagram **samen** voor wie gepost heeft. De Worker leest daarvoor ook de openbare tabs `ig_handles`, `ig_history`, `ig_posts` en `ig_baseline` (alleen handles, geen namen); zolang de eerste Instagram-run er niet is, zijn ze leeg en toont Overzicht één melding (*Instagram is nog niet opgehaald*) in plaats van een badge bij elke leerling.

- **Eén post op één van de platforms is genoeg** voor een blauwe dag. Daarop volgen: reeks (huidig en langste), gemiste dagen, *X dagen geen post*, dagopdrachten (posts van beide platforms tellen op), *Actie nodig* en *Vandaag* (klaar = minstens één post vandaag, of het minimum van de dagopdracht). Met de muis op een kalendervakje staat het platform: *2 posts (1 op TikTok, 1 op Instagram)*.
- **Alleen TikTok heeft cijfers.** Weergaven, likes, reacties, gedeeld, engagement, mediaan, beste video en de TikTok-volgers tellen alleen TikTok-posts mee (een Instagram-record bevat die niet); ze heten op de leerlingpagina *Weergaven (TikTok)* en *Volgers (TikTok)* zodra de leerling ook Instagram heeft. De kaart *Posts* toont het totaal met *TikTok x, Instagram y*. Hashtags van beide platforms staan samen op de leerlingpagina.
- **Leerlingpagina:** de koppen *@naam op Instagram ↗* en *@naam op TikTok ↗*, de kaart **Volgers (Instagram)** (aantal, en *+n sinds* de eerste meting van dat account), de tabel **Instagram-posts in de campagne** (tijdstip, foto/reel/carrousel, hashtags, link naar de post) en het keuzemenu *Cijfers van*: alle accounts samen, alleen een TikTok-account, of alleen Instagram. Onderaan de kalender en de Instagram-tabel staat *Stories worden niet meegeteld.* Instagram laat alleen de posts zelf zien (geen likes, reacties of weergaven); alleen posts vanaf `instagram.start_date` tellen mee.
- **Meer dan één account** (twee op TikTok, of TikTok en Instagram): ▸ *2 accounts* in Overzicht en de Leerlingen-kalender opent een rij per account, ook de Instagram-rij. Naast de TikTok-handle(s) staat in lijsten `IG @naam`.
- **Alleen Instagram:** een leerling zonder TikTok-handle (actieve rij met alleen `instagram_handle`) staat nu ook in Overzicht, Leerlingen, Vandaag en Export, met sleutel `instagram:<handle>`. Omdat Instagram vóór `instagram.start_date` niet is opgehaald, zijn die dagen voor zo'n leerling *vrij* (*nog niet gevolgd*): niet gemist en geen onderbroken reeks. Een leerling met ook TikTok heeft die uitzondering niet: TikTok telt vanaf de eerste campagnedag.
- **Waarschuwingen per account**, met het platform erbij zodra een leerling beide heeft: *privé (Instagram)*, *niet gevonden (Instagram)*, *nog niet opgehaald (Instagram)*, naast *privé (TikTok)* enz. Ze staan ook onder *Actie nodig*. Een leerling is op Vandaag alleen *privé* (niet te controleren) als **alle** accounts privé zijn.
- **Controleer nu** haalt de openbare accounts van beide platforms op van wie nog niet gepost heeft (zie *Vandaag en Controleer nu*); een post op één van beide platforms telt voor *klaar*.
- **Export** heeft er vijf kolommen bij: `tiktok_posts`, `instagram_handle`, `instagram_posts`, `instagram_volgers` en `instagram_volgers_sinds_start`. `posts`, `dagen_met_post`, `gemiste_dagen`, `huidige_reeks`, `langste_reeks`, `laatste_post`, `hashtags` en `opdrachten_niet_gehaald` tellen beide platforms; de overige cijfers zijn TikTok.
- De openbare site, de grafieken, de ranglijsten en de presentatie blijven in deze stap TikTok; Instagram komt daar bij de twee ranglijsten.

### Dagopdrachten

Op **Beheer → Dagopdrachten**: een dag waarop elke leerling minimaal een aantal posts moet plaatsen (2 of meer), met een optionele omschrijving. Toevoegen, wijzigen en verwijderen kan zonder deploy; het staat in de privétab `dagopdrachten` en elke wijziging komt in het activiteitenlog.

- In de kalender (Leerlingen) staat op zo'n dag **3/5** (posts/minimum), met een **oranje rand** als het niet gehaald is. Op Overzicht komt een waarschuwing (*opdracht 2 okt: 3/5*) en de leerling staat bij *Actie nodig*.
- Kolom *opdrachten niet gehaald* in de tabel van Leerlingen en in de Export.
- Een dagopdracht **breekt de reeks niet** en telt niet als *gemist* zolang er die dag minstens één post is. Nul posts is gewoon een gemiste dag (behalve op een vrije dag).
- Vandaag telt pas als *niet gehaald* als de dag voorbij is, net als gemiste dagen.

### Buiten schaal (uitschieter)

Heeft één account bijv. 2,3 miljoen weergaven en de rest minder dan 100.000, dan is elke grafiek één lijn met een platte vloer. Zet dat account op **Beheer → Alle leerlingen → Buiten schaal**.

- **Grafieken** (openbaar *Grafiek* en *Groei*, de grafiek in de presentatie): de y-as schaalt zonder dat account. Het staat als grijs **▲** bovenaan met de handle en het echte getal. Ook de balkjes van *Stijgers* (presentatie) en *Video's* schalen zonder het account; dat van het account loopt grijs door tot het eind.
- **Plaats, podium en tabellen veranderen niet**: het account staat gewoon op zijn echte plaats met zijn echte cijfers.
- Op de beheerpagina kun je bij *Stijgers* en *Hashtags* het account weglaten met **zonder buiten schaal** (staat standaard aan zodra er een account gemarkeerd is).
- Opgeslagen in de openbare tab `outliers` (alleen handles), zodat de openbare site, de beheerpagina en de presentatie het allemaal volgen. Weer aanzetten: dezelfde knop (*In schaal*).

### Opvallend (geen oordeel)

Het tabblad **Opvallend** (alleen op de beheerpagina) laat cijfers zien die veel afwijken van de rest van de klas. Er staat nergens "bot": elke melding toont de cijfers erachter en een link naar de video of het profiel, en de docent beoordeelt zelf. Het wordt in de browser berekend uit `posts_latest`, `post_history` en `history`; er wordt niets opgeslagen en niets komt in de openbare sheet of de Actions-logs.

- **Likes per weergave** veel lager of hoger (3×) dan de mediaan van de klas.
- **Groei in één sprong**: 60% of meer van de weergaven van een video kwam binnen in één stap (binnen 2,5 uur) en daarna 6 uur bijna niets.
- **Geen reacties of shares** bij 5.000 of meer weergaven.
- **Volgers-sprong**: 100 of meer volgers erbij tussen twee runs, met 5× minder nieuwe weergaven per nieuwe volger dan de klas.
- Kleine video's (onder 1.000 weergaven) worden nooit gemeld. Alle drempels staan in `config.yaml` onder `signals`.

### Finale (laatste les)

Op **Beheer → Finale**:

1. Kies de **deadline** (dag + tijd, Nederlandse tijd, 24-uursklok) en klik **▶ Start finale**. Je ziet vooraf wat het kost: 4 runs per uur × het aantal actieve accounts van TikTok én Instagram samen (bij 61 + 23 accounts ≈ 336 records per uur), en of het binnen de maandlimiet past; zo niet, dan start hij niet.
2. Tijdens de finale: profielen van **TikTok en Instagram elke 15 minuten** (de gewone runs vervallen dan; voor TikTok verandert dat in een latere stap naar alleen aan het begin en bij de laatste run), op de presentatie (openbaar en privé) en bovenaan beide sites een **aftelklok** en **LIVE**-labels. De eerste run start meteen.
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

Statische site in `site/` (HTML + Chart.js). Leest de gepubliceerde CSV's van `handles`, `history`, `posts_latest`, `finale` en `outliers`, en ververst zichzelf elke 10 minuten (tijdens een finale elke 2 minuten). `post_history` wordt alleen geladen voor *Video's* en accountpagina's.

- **Stand**: ranglijst op totaal weergaven, met `+ 24 uur` (vergeleken met de meting van 24 uur eerder; het schuift mee en springt niet terug om middernacht), stijgers/dalers (▲▼) en een label *privé* voor accounts die op privé staan. Klik op **Weergaven, Volgers, Posts of Likes** om daarop te sorteren (hoog → laag); nog een keer klikken draait de volgorde om. Het nummer blijft de echte plaats in de stand. Op een telefoon kies je dit met *Sorteer op*.
- **Grafiek**: tot 8 accounts tegelijk over tijd; wissel tussen weergaven, volgers, posts en likes, en tussen **Alles / 7 dagen / 48 uur** (met 12 metingen per dag zie je zo het verloop binnen een dag; bij korte periodes staan er ook uren op de as). Overige accounts kunnen grijs erbij. Een account *buiten schaal* staat als grijs ▲ bovenaan met zijn echte getal.
- **Groei**: erbij per dag of per week (per dag = laatste meting van die dag min die van de dag ervoor), plus de grootste stijgers.
- **Video's**: *Snelste stijgers*, de video's met de meeste nieuwe weergaven in de laatste 2, 6 of 24 uur.
- **Hashtags**: de meest gebruikte hashtags en de hashtags met de meeste weergaven (van campagneposts), met het aantal accounts. Klik op een hashtag om te zien welke accounts hem gebruiken.
- **Twee accounts**: een deelnemer met twee accounts staat als `@merk + @reclame` in de stand, met ▸ *2 accounts* voor de cijfers per account; op de accountpagina kies je *beide accounts samen* of één account.
- **Account**: klik op een account voor details, de eigen hashtags, **weergaven per video over tijd** (de snelste stijger van de laatste 24 uur in oranje) en alle posts.
- **Finale**: bovenaan een aftelklok met LIVE; na de deadline *Eindstand* boven de stand.
- Knop **▶ Presentatie** rechtsboven: opent de presentatiemodus in een nieuw tabblad.

**Snelheid** (getest met 4× langzamere processor en 10 Mbit/s, met data van het einde van de campagne): presentatie eerste dia ≈ 1,8 s, verversen ≈ 1,2 s; site ≈ 1,7 s. De presentatie laadt `post_history` nooit. Het tabblad *Video's* laadt het wel: aan het eind van de campagne ≈ 5–6 MB, ≈ 7 s de eerste keer (daarna 10 minuten in het geheugen). Wordt dat te traag, dan kan de collector een klein voorberekend tabblad (`video_trends`) schrijven.

**Na het toevoegen van een nieuw openbaar tabblad** (eerder `post_history` en `finale`; `outliers` heeft een vaste `gid` en wordt door de collector zelf aangemaakt, dus daarvoor hoeft niets): draai eenmalig **Actions → Collect TikTok stats → `setup`** (geen dry-run). Die maakt de tabbladen aan en zet in de samenvatting hun `gid`; die horen in `site/config.js` onder `gids`.

De site leest de CSV via de "Publiceren op internet"-link: `publishedId` in `site/config.js` is het deel van die link dat met `2PACX-` begint. Publiceer je de sheet opnieuw en verandert de link, pas het dan daar aan. De workflow *Check website* controleert na elke deploy of de links en de site werken, ook de presentatiemodus op 1920×1080 en 1280×720.
