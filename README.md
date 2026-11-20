# Doodle deník

Osobní seznam krátkých doodle tutoriálů z jednoho YouTube playlistu. Videa jde pouštět přímo na stránce, odškrtávat hotová a měnit pořadí těch, která zbývají. Stav se ukládá do Firebase (Firestore), takže je stejný na všech zařízeních.

Stránka je čisté HTML, CSS a JS bez build kroku a běží na GitHub Pages na adrese `https://<uživatel>.github.io/<repo>/`.

## Kontrolní seznam nastavení

Dokud není hotový bod 1, stránka funguje jen na čtení: videa jdou pouštět, ale nejde se přihlásit ani nic ukládat. Nahoře to stránka sama hlásí.

### 1. Firebase

- [ ] V [konzoli Firebase](https://console.firebase.google.com/) vytvoř projekt (Google Analytics nejsou potřeba).
- [ ] Project settings → General → Your apps → přidej **webovou aplikaci** (ikona `</>`). Hosting nezaškrtávej.
- [ ] Z části „SDK setup and configuration“ zkopíruj hodnoty z `firebaseConfig` do souboru [`firebase-config.js`](firebase-config.js) a commitni ho. Tyhle hodnoty nejsou tajné; data chrání pravidla Firestore. Kdyby tě GitHub upozornil na „Google API Key“ v repozitáři, u webové konfigurace Firebase je to v pořádku.
- [ ] Authentication → Get started → Sign-in method → zapni **Google**.
- [ ] Firestore Database → Create database → zvol **production mode** a umístění (třeba `eur3`).
- [ ] Firestore Database → záložka **Rules** → vlož obsah souboru [`firestore.rules`](firestore.rules) → Publish. Své UID doplníš v bodě 5.

### 2. Povolená doména pro přihlášení

- [ ] Authentication → Settings → **Authorized domains** → Add domain → `<uživatel>.github.io` (bez `https://` a bez názvu repozitáře).

### 3. YouTube API klíč (automatické přidávání nových videí)

- [ ] V [Google Cloud Console](https://console.cloud.google.com/) vyber projekt (může to být ten, který vytvořilo Firebase).
- [ ] APIs & Services → Library → **YouTube Data API v3** → Enable.
- [ ] APIs & Services → Credentials → Create credentials → **API key**. U klíče nastav API restrictions → Restrict key → jen **YouTube Data API v3**. Omezení podle webu nebo IP adresy nenastavuj, klíč používá GitHub Actions.
- [ ] V repozitáři na GitHubu: Settings → Secrets and variables → Actions → New repository secret, název **`YOUTUBE_API_KEY`**, hodnota = klíč.
- [ ] Zkontroluj ID playlistu v [`scripts/update_playlist.py`](scripts/update_playlist.py) (konstanta `PLAYLIST_ID`). Je to část adresy playlistu za `list=`. Nastavené `PLepb8U4Vq3Fg` je kratší, než bývá obvyklé (běžně kolem 34 znaků), takže může být zkrácené. Když nesedí, skript skončí chybou a seznam videí nechá beze změny.

Bez klíče všechno ostatní funguje dál, jen se nová videa z playlistu nepřidávají sama.

### 4. GitHub Pages

- [ ] Settings → Pages → Build and deployment → Source: **GitHub Actions**.
- [ ] Změny musí být ve větvi `main`. Nasazení spouští workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml) při každém pushi do `main`, denně kolem 5:00 UTC a ručně (Actions → Aktualizace a nasazení → Run workflow).

### 5. První přihlášení a UID do pravidel

- [ ] Otevři stránku a přihlas se přes Google. Stránka teď nahlásí, že Firestore odmítl přístup. To je v pořádku, pravidla ještě neznají tvoje UID.
- [ ] Dole na stránce v panelu **Účet** klikni u Firebase UID na **Kopírovat**.
- [ ] V konzoli Firebase otevři Firestore Database → Rules, nahraď `VLOZ_SVOJE_UID` svým UID (uvozovky nech) a klikni na Publish. Soubor `firestore.rules` v repozitáři zůstává jako šablona, UID do veřejného repozitáře dávat nemusíš.
- [ ] Na stránce klikni na „Zkusit znovu“ (nebo ji obnov). Deník se při prvním načtení založí z dosavadního stavu (`data/seed.json`): 16 hotových videí a tvoje pořadí.

Po tomhle prvním převodu se `data/seed.json` už nepoužívá a můžeš ho smazat. Kdyby pak dokument ve Firestore někdy chyběl, deník začne od nuly v pořadí playlistu.

## Jak to funguje

- **Seznam videí** je v `data/videos.json` (`id`, `title`, `duration`) v pořadí playlistu. Workflow ho každý den aktualizuje skriptem `scripts/update_playlist.py` (jen standardní knihovna Pythonu) a změnu commitne jako `github-actions[bot]`.
- **Náhledy** jsou čtverce 144×144 v `thumbs/<id>.jpg`. Vyrábí je `scripts/make_thumbs.py` (Python a Pillow). Videa jsou svislá a YouTube je vkládá do rámu 16:9 s rozmazanými pruhy po stranách, takže skript z `maxresdefault.jpg` (1280×720) vyřízne jen čtverec 360×360 ze středu, uvnitř samotného videa. Workflow ho spouští hned po aktualizaci seznamu a nové náhledy commitne spolu s `data/videos.json`. Existující soubory nepřepisuje. Dokud náhled chybí, stránka ukazuje šedý čtverec a video jde pustit.
- **Ruční ořez** jednoho náhledu: do `data/thumb_overrides.json` přidej `"<id>": [left, top, side]` (čtverec v pixelech obrázku 1280×720), smaž `thumbs/<id>.jpg` a spusť skript znovu.
- **Stav** je jeden dokument ve Firestore `users/{uid}` s poli `done` (ID videa → datum `RRRR-MM-DD`) a `order` (pořadí všech ID). Ukládá se jen při změně, rychlé změny se slučují (asi 600 ms). Změna z jiného zařízení se projeví hned.
- **Nová videa** se objeví na konci seznamu „Zbývá“. Videa, která z playlistu zmizí, se ze seznamu vyřadí.
- **Přihlášení** je přes Google (vyskakovací okno, při jeho selhání přesměrování). Nepřihlášený návštěvník vidí jen seznam a může pouštět videa.
- **Firebase SDK** se načítá z CDN `https://www.gstatic.com/firebasejs/13.2.0/` (verze je v `app.js`, konstanta `FIREBASE_VERSION`).

## Spuštění na vlastním počítači

ES moduly nejdou otevřít přímo ze souboru, je potřeba malý server:

```bash
python3 -m http.server 8000
```

Pak otevři `http://localhost:8000/`. Přihlášení bude fungovat, jen když přidáš `localhost` mezi Authorized domains (ve Firebase tam obvykle už je).

Ruční aktualizace seznamu videí:

```bash
YOUTUBE_API_KEY=tvuj-klic python3 scripts/update_playlist.py
```

Ruční výroba chybějících náhledů:

```bash
pip install pillow
```

```bash
python3 scripts/make_thumbs.py
```
