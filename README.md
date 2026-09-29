# TikTok-campagne tracker

Houdt de TikTok-statistieken bij van de klas tijdens de Social Media Campagne (28 sept – 26 okt 2026) en toont de stand op een website.

```
Bright Data (TikTok-scraper)  →  GitHub Actions (collector/)  →  Google Sheets  →  website (site/, GitHub Pages)
```

- **Profielen** van alle accounts worden twee keer per dag opgehaald (ca. 07:00 en 18:00 Nederlandse tijd). Eén profiel kost 1 record en bevat de statistieken van de ~16 nieuwste video's.
- **Weekrefresh** op vrijdag vanaf 08:30: haalt alleen campagneposts op die ouder zijn dan dat venster van ~16 video's, zodat late weergaven op oudere video's ook meetellen. Accounts waarbij het venster al teruggaat tot vóór de campagnestart worden overgeslagen (0 records).
- Alleen video's die zijn geplaatst **vanaf 28 september** tellen mee. Foto-/carrouselposts tellen mee, reposts niet.
- Weergaven van een video kunnen nooit omlaag: valt een video uit het venster, dan blijven de laatst bekende cijfers staan.

## Privacy

- De repository en de website zijn **openbaar**. Er staan geen sleutels, geen namen en geen gescrapete data in de repo.
- Er zijn **twee spreadsheets**:
  - **Privé** (`admin_id` in `config.yaml`): tabblad `accounts` met namen, plus `run_log` en `profile_window`. Deze sheet **nooit** publiceren of delen via een link.
  - **Openbaar** (`data_id`): alleen TikTok-handles. Deze wordt gepubliceerd als CSV en de website leest die.
- De logs van GitHub Actions zijn openbaar; de collector schrijft daar alleen handles en aantallen in, nooit namen.

## Tabbladen

| Sheet | Tabblad | Inhoud |
|---|---|---|
| privé | `accounts` | `student_name`, `tiktok_handle`, `active` (ja/nee) — **dit vul je zelf in** |
| privé | `run_log` | per run: tijd, type, venster, dry-run, verwachte en echte records, fouten, status, notities |
| privé | `profile_window` | per account: hoeveel video's het profiel teruggaf en de oudste datum daarvan (voor de weekrefresh) |
| openbaar | `handles` | actieve handles, privé ja/nee, laatste status |
| openbaar | `profile_snapshots` | volgers, volgend, likes, aantal video's per run |
| openbaar | `posts_latest` | één rij per video (`video_id`), steeds bijgewerkt met de nieuwste cijfers |
| openbaar | `history` | per run per account: totaal weergaven, volgers, likes en posts in de campagne (voor de grafieken) |

### Accounts toevoegen

Zet in `accounts` per leerling een rij. De handle mag in elke vorm: `@naam`, `naam`, `https://www.tiktok.com/@naam`, met hoofdletters of spaties. Ongeldige handles (bijv. een korte `vm.tiktok.com`-link) worden overgeslagen en gemeld in `run_log`; de run gaat gewoon door. Zet `active` op `nee` om een account niet meer te volgen (leeg = ja).

## Kosten en budget

- Bright Data rekent per record: 1 profiel = 1 record, 1 post = 1 record. 5.000 records per kalendermaand zijn gratis, daarna ca. $1,50 per 1.000.
- **Harde limiet:** `budget.monthly_cap` in `config.yaml` (nu 4.500). Vóór elke run telt de collector de records van deze maand op uit `run_log` en weigert de run (status `refused`) als het totaal boven de limiet zou komen.
- Vóór een weekrefresh of controle wordt ook budget **gereserveerd** voor alle profielruns die deze maand nog komen, zodat de hoofdbron nooit zonder budget komt te zitten.
- De weekrefresh haalt maximaal `posts_refresh.num_of_posts` posts per account op (nu 20). Dat is ook de bovengrens die de dry-run gebruikt.
- Schatting bij 45 accounts: proefweek ≈ 700 records; oktober ≈ 2.950 (realistisch) tot ≈ 4.140 (als iedereen heel veel post).

## Schema

GitHub-cron draait in UTC en is vaak 5–30 minuten te laat of slaat soms een keer over. Daarom start de workflow meerdere keren per tijdvak, en kijkt de collector zelf naar de Nederlandse tijd en `run_log`: elk tijdvak draait precies één keer, en een mislukte poging wordt bij de volgende start opnieuw geprobeerd (maximaal 2 keer). Zomer- en wintertijd gaan zo vanzelf goed.

| Run | Tijdvak (Amsterdam) |
|---|---|
| Profielen ochtend | 06:30 – 07:59 |
| Profielen avond | 18:00 – 19:59 |
| Weekrefresh | vrijdag 08:30 – 10:00 |
| Eenmalige controle | 5 okt, direct na de avondrun |

Alles staat in **`config.yaml`**. Pas je tijden aan, controleer dan ook de `cron`-regels in `.github/workflows/collect.yml` (de test `test_cron_covers_windows` controleert dat).

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
| `profiles` | profielen nu ophalen |
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

## Eenmalige installatie

1. **Secrets** (Settings → Secrets and variables → Actions): `BRIGHTDATA_API_KEY` en `GOOGLE_SERVICE_ACCOUNT_B64`.
2. Deel **beide** sheets met het service-account als Editor.
3. **Openbare sheet publiceren:** Bestand → Delen → Publiceren op internet → Hele document, CSV → Publiceren. (Alleen de openbare sheet!)
4. **GitHub Pages:** Settings → Pages → Source: *GitHub Actions*. De workflow *Deploy website* zet `site/` online bij elke wijziging op `main`.
5. Geplande workflows draaien alleen vanaf de standaardbranch (`main`).

## Website

Statische site in `site/` (HTML + Chart.js). Leest de gepubliceerde CSV's van `handles`, `history` en `posts_latest`, en ververst zichzelf elke 10 minuten.

- **Stand**: ranglijst op totaal weergaven, met `+ sinds gisteren`, stijgers/dalers (▲▼) en een label *privé* voor accounts die op privé staan.
- **Grafiek**: tot 8 accounts tegelijk over tijd; wissel tussen weergaven, volgers, posts en likes. Overige accounts kunnen grijs erbij.
- **Groei**: erbij per dag of per week, plus de grootste stijgers.
- **Account**: klik op een account voor details en alle posts.

Werkt de CSV-link niet? Vul dan in `site/config.js` bij `publishedId` het deel van de "Publiceren op internet"-link in dat met `2PACX-` begint.
