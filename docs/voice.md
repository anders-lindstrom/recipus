# Rösten — lägga till varor genom att säga dem

Två vägar in, en motor. Det här dokumentet är körschemat för båda.

## Varför två vägar, och inte en

Det korta svaret: **Alexa kan inte svenska.**

Amazon stödjer 17 lokaler för custom skills — `ar-SA`, `de-DE`, `en-AU`, `en-CA`,
`en-GB`, `en-IN`, `en-US`, `es-ES`, `es-MX`, `es-US`, `fr-CA`, `fr-FR`, `hi-IN`,
`it-IT`, `ja-JP`, `nl-NL`, `pt-BR` — och `sv-SE` finns inte bland dem
([Develop Skills in Multiple Languages][locales]). Det står i produktnamnet på
amazon.se också: *"Echo Dot … International Version … Swedish language not
available"*.

Att lägga svenska ord i en custom slot i en engelsk modell hjälper inte.
Alexas akustiska modell är engelsk och transkriberar svenska fonem till
**engelska ord innan** slot-upplösningen kör. "Mjölk" når servern som "mulk"
eller "me elk". Det går inte att laga från skill-sidan.

Och den variant som hade varit riktigt bra — *"Alexa, add milk to the shopping
list"* rakt in i Alexas egen lista, utan invokationsnamn — stängdes av:

> "As of July 1, 2024, List skills and the List Management REST API to access
> Alexa lists, such as the Alexa Shopping and To-Do lists, in your skills or
> apps are no longer supported." ([Deprecated Features][deprecated])

Det dödar båda riktningarna: att skriva till Alexas lista, och att prenumerera
på dess händelser. Ingen ersättning är annonserad. AnyList, den mest kända
integrationen, tvingades tillbaka till `"Alexa, tell AnyList to add milk"`.

Därför:

| Väg | Språk | Vad du säger |
|---|---|---|
| **Home Assistant** | Svenska | *"Lägg till mjölk och bröd"* |
| **Alexa** | Engelska | *"Alexa, tell shopping helper to add milk"* |

Home Assistant är den väg som faktiskt blir bra. Alexa finns för att Echo-
enheterna redan står i huset.

## Motorn, som är gemensam

Båda adaptrarna anropar samma `ingestUtterance` (`src/lib/services/voice-ingest.ts`):

1. `interpretUtterance` läser meningen som de saker den nämner — skalar bort
   "lägg till" / "add … to the shopping list", delar på *och* / *and* / komma,
   och plockar ut mängder med samma parser som sökraden.
2. `resolveSpokenItems` matchar varje namn mot **hela ordförrådet** —
   `loadMatchCandidates()`, som tar med `catalog_item_aliases`. Det är så
   engelska når den svenska katalogen: `milk` → `mjölk` är en aliasrad, samma
   mekanism som håller ett bortslaget ord vid liv efter en sammanslagning.
3. Ops läggs på genom `applyOpToDatabase`, precis som `/api/ops` gör. Ett
   inlagt ord via rösten är alltså inte skiljbart från ett tryck: samma
   reducerare, samma köphistorik, samma SSE-utskick till alla telefoner.

**Rösten skapar aldrig en vara.** Sökraden vägrar redan låta en luddig träff
avgöra att ett ord är nytt — en felstavning som löser sig är återställbar, en
som skapar en 343:e katalogvara är permanent. Tal är brusigare än en tumme och
har ingen skärm att fånga misstaget på. Det som inte matchar rapporteras och
sägs högt.

## Miljövariabler

```bash
# Home Assistant-dörren
VOICE_INGEST_SECRET=$(openssl rand -hex 32)
VOICE_ACTOR=anders          # måste vara en riktig hushållsmedlem

# Alexa-dörren
ALEXA_SKILL_ID=amzn1.ask.skill.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
ALEXA_ACTOR=anders
ALEXA_LIST_ID=              # tomt = hushållets första lista
```

Ingen av dem faller tillbaka på "oskyddad" när den saknas. Utan
`VOICE_INGEST_SECRET` svarar `/api/voice` **503**, inte 200. Samma regel som
`authenticate()` som vägrar starta utan `PROXY_AUTH_SECRET`: en hemlighet vars
frånvaro tyst stänger av autentiseringen upptäcks av någon annan som hittar din
inköpslista.

## Nginx Proxy Manager: släpp förbi Authelia

Båda ändpunkterna sitter **före** Authelia-grinden i appen, men NPM måste också
sluta kräva en session för dem — annars ser de aldrig ett anrop.

I NPM, på recipus-hosten → **Advanced** → Custom Nginx Configuration:

```nginx
location /api/alexa {
    # Amazon har ingen Authelia-session och kan inte få en. Anropet bevisas
    # i stället av en signatur, som appen verifierar mot Amazons certkedja
    # innan den ens tittar på bodyn — plus en kontroll av skill-id:t, som
    # verifieraren medvetet inte gör.
    proxy_pass http://recipus:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Proxy-Auth "";
}

location /api/voice {
    # Bara LAN. Home Assistant står på samma maskin; ingenting utifrån har
    # anledning att nå den här dörren, och en bearer-nyckel är ett svagare
    # skydd än en signatur.
    allow 192.168.0.0/16;
    allow 172.16.0.0/12;
    deny all;
    proxy_pass http://recipus:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Proxy-Auth "";
}
```

> `/api/alexa` **måste** ligga på port 443 med ett certifikat där värdnamnet
> står i SAN-fältet. Let's Encrypt genom NPM uppfyller det. Alexa accepterar
> självsignerat *bara* i utvecklingsläge.

## Home Assistant

Du har ingen svensk STT-pipeline uppe ännu, så det här är i ordning.

### 1. Whisper

Settings → Add-ons → **Whisper**. Modell: börja på `small` eller `medium`;
`tiny` klarar inte svenska matvaruord. Språk: `sv`.

Prova innan du köper hårdvara — svensk igenkänning varierar mycket med
modellstorlek, och hela nyttan står och faller med om "filmjölk" kommer fram.

### 2. Assist-pipeline

Settings → Voice assistants → Add assistant. Språk **Svenska**, STT = Whisper,
TTS = Piper (svensk röst).

### 3. rest_command

I `configuration.yaml`:

```yaml
rest_command:
  recipus_add:
    url: "https://recipus.lindstromhome.cc/api/voice/utterance"
    method: POST
    headers:
      Authorization: !secret recipus_voice_token
      Content-Type: application/json
    payload: >
      {"phrase": {{ phrase | tojson }}, "locale": "sv", "speaker": "anders"}
    timeout: 15
```

`!secret recipus_voice_token` ska vara hela strängen `Bearer <VOICE_INGEST_SECRET>`.

### 4. Intent

`intents.yaml` (eller custom_sentences/sv/recipus.yaml):

```yaml
language: sv
intents:
  RecipusAdd:
    data:
      - sentences:
          - "lägg till {phrase}"
          - "lägg till {phrase} på inköpslistan"
          - "sätt upp {phrase}"
          - "skriv upp {phrase}"
          - "vi behöver {phrase}"
          - "jag behöver {phrase}"
lists:
  phrase:
    wildcard: true
```

Och i `configuration.yaml`:

```yaml
intent_script:
  RecipusAdd:
    action:
      - service: rest_command.recipus_add
        data:
          phrase: "{{ phrase }}"
        response_variable: result
    speech:
      text: "{{ result.content.speech }}"
```

Appen returnerar en färdig svensk mening i `speech` — den namnger både vad som
lades till och vad den inte hittade. Läs den rakt av; sammanfatta den inte.

## Alexa

### Det du måste klicka på

Skill-definitionen ligger i repot (`alexa/skill.json`,
`alexa/interactionModels/custom/en-GB.json`) och kan deployas med ASK CLI, men
följande går inte att skripta:

1. Skapa ett Amazon Developer-konto (developer.amazon.com) och acceptera avtalet.
2. `npm i -g ask-cli && ask configure` — logga in, välj vendor.
3. `cd alexa && ask deploy --target skill-metadata`
4. Ta skill-id:t ur utdatan och sätt `ALEXA_SKILL_ID` i produktionsmiljön.
   **Utan den kontrollen kan vilken signerad skill som helst i världen skriva
   till hushållets lista** — signaturen bevisar att anropet kom från Amazon, inte
   att det kom från *din* skill.
5. Registrera Echo-enheterna på **samma** Amazon-konto som utvecklarkontot.

### Distribution: lämna den i Development

Tre vägar finns, och två är återvändsgränder:

- **Private skills for organizations** — borta. *"The Private Skill Distribution
  REST API is no longer available."*
- **Beta test** — funkar, upp till 500 testare, men **löper ut efter 90 dagar**
  och kan inte förlängas. Varje omgång kräver att testarna accepterar på nytt.
- **Development stage** — funkar hur länge som helst, för enheter registrerade
  på utvecklarkontot. **Det här är svaret för ett hushåll.** Echo-enheter i ett
  hem ligger ändå oftast på ett konto. Amazon Household täcker en andra vuxen.

En skill kan bara vara aktiverad för test i *ett* stadium åt gången — slår du på
Live-test stängs Development av.

### Vad du faktiskt säger

```
"Alexa, tell shopping helper to add milk"
"Alexa, tell shopping helper to add milk and bread"
"Alexa, open shopping helper"  →  "What should I add to the shopping list?"
```

Invokationsnamnet måste vara minst två ord och får inte innehålla `alexa`,
`amazon`, `echo`, `skill`, `app`, eller ett startord som `ask`/`open`/`tell`.
`shopping helper` uppfyller det. Ändrar du det, ändra `invocationName` i
interaktionsmodellen och deploya om.

## Felsökning

| Symptom | Trolig orsak |
|---|---|
| `/api/voice` svarar 503 | `VOICE_INGEST_SECRET` är inte satt i containerns miljö |
| `/api/voice` svarar 401 | Headern saknar `Bearer `-prefixet, eller nyckeln skiljer sig |
| Alexa svarar "Invalid request signature" | NPM parsar eller buffrar bodyn; signaturen går över råa bytes |
| Alexa svarar "Unknown skill" | `ALEXA_SKILL_ID` matchar inte den deployade skillen |
| Allt hamnar i `unresolved` | Aliastabellen är inte seedad — se `pnpm db:seed` |
| Rätt ord, fel vara | Ett alias pekar fel. Fixa raden i `catalog_item_aliases` |
| Svenska ord kommer fram som nonsens via Alexa | Förväntat, och inte lagbart. Använd Home Assistant |

[locales]: https://developer.amazon.com/en-US/docs/alexa/custom-skills/develop-skills-in-multiple-languages.html
[deprecated]: https://developer.amazon.com/en-US/docs/alexa/ask-overviews/deprecated-features.html
