# Recipus — AI-tillägg: bild, text och röst in på listan

**Date:** 2026-08-13
**Status:** specified, not built
**Scope:** one new surface (`AiAddSheet`), one new read-only endpoint
(`/api/ai/parse`), one new engine module (`src/lib/ai-add/`), and a rebuilt
share target. No change to `/api/voice`, `/api/alexa`, or the reducer.

---

## 1. Vad det här är

Tre sätt att få många varor på listan i ett svep, som alla mynnar ut i samma
granskningsdialog:

| Väg | Vad du gör | Var den lever |
|---|---|---|
| **Bild** | Skärmdump från Bring, delad eller vald ur kamerarullen | Delmål + filväljare |
| **Text** | Klistrar in eller skriver en klump — "ägg, mjölk, keso" | Textrutan i bladet |
| **Röst** | Säger vad du behöver, i köket | Mikrofonen i bladet |

Dialogen visar vad som *förstods*, du bockar bort det du inte vill ha, och
trycker en gång. Det är samma kontrakt som `RecipeAddSheet` — du ser vad som
kommer att hända innan det händer — och den likheten är avsiktlig ner till
radmarkeringen.

## 2. Motorn: modellen är en ytterdörr, inte en andra matchare

Det bärande beslutet. Modellen får **aldrig** se ett `catalogItemId` och får
aldrig hitta på ett.

```
bild/text/transkript
   └─ parseWithLlm()      → { lines: [{ text: "2 l mjölk", group }] }
        └─ interpretUtterance(line)   → SpokenItem[]  (samma som rösten)
             └─ resolveSpokenItems(items, loadMatchCandidates())
                  └─ dedupeResolutions()
                       └─ rader till dialogen
```

Modellens hela uppgift är *stökigt in, städade svenska rader ut*. Vilken vara en
rad betyder avgörs sedan av `matchIngredient` mot `loadMatchCandidates()` —
exakt den matchare rösten och recepten redan använder, med aliasen som är hela
skälet till att ett engelskt ord når den svenska katalogen.

Alternativet — ge modellen hela katalogen på 341 varor och be om id:n — avvisades
av samma skäl som reduceraren körs på båda sidor: två läsningar av "vilken vara
menas här" driver isär, och bara den ena har tester. Det hade dessutom kostat en
katalogstor prompt per anrop.

Att `interpretUtterance` körs på varje rad ger tre saker gratis: `splitQuery`
läser "2 l" här precis som i sökraden, "salt och peppar" blir två varor, och en
kvarglömd bärfras ("lägg till …") skalas bort i stället för att skickas till
matcharen.

### 2.1 Grupperna

`group` är modellens enda omdöme utöver att läsa:

- **`list`** — rader från själva listan. Förbockade.
- **`other`** — förslagsrutnätet ("senast använda"), gråa rader, redan avbockade
  rader. Visas under **"Också på bilden"**, obockade.

Ingenting kastas tyst. En Bring-skärmdump har ett förslagsrutnät på tjugo varor
under listan, och att ta med dem alla hade gjort det vanliga fallet till tjugo
tryck; att tolka bort dem hade gjort en felbedömd gräns osynlig. Två grupper är
det enda svaret som varken tystar eller dränker.

### 2.2 Anropet

`src/lib/ai-add/parse.ts`, byggd som `src/lib/recipes/llm.ts`: `messages.parse`
med `zodOutputFormat`, `claude-opus-5`, `stop_reason === "refusal"` kollas före
`parsed_output`, och **ingen felväg kastar** — allt slutar i `null`.

Systemprompten säger: svenska, en sak per rad, behåll mängden i raden, normalisera
inte bort hushållets ord, gissa inte fram varor som inte står där.

### 2.3 När modellen inte finns

`ANTHROPIC_API_KEY` saknas, anropet vägrar, nätet dör: **text faller igenom till
`interpretUtterance` på råtexten**. "ägg, mjölk och keso" fungerar utan nyckel,
för det är precis vad röstmotorn redan gör bra. Bild är det enda som hårt kräver
nyckeln: `kind: "image"` utan nyckel svarar 503 med en mening som säger varför,
medan `kind: "text"` aldrig gör det — den har alltid en väg framåt.

Det här är en nedgradering, inte ett nytt felläge: koden som kör är kod som redan
körs i produktion för Home Assistant.

## 3. Endpointen

`POST /api/ai/parse`, **innanför** Authelia-grinden till skillnad från
`/api/voice` — anroparen är en webbläsare med session, och då finns ingen
anledning till en egen nyckel.

```ts
// in
{ kind: "text",  text: string }
{ kind: "image", data: string /* base64 */, mediaType: string }
{ kind: "share", token: string }   // bilden ligger i shareInbox, se §5.1

// ut
{ rows: Array<{
    id: string;                 // radens egen nyckel i dialogen
    said: string;               // som det lästes, ordagrant
    name: string;               // namnet med mängden avskalad
    amount: Amount | null;
    catalogItemId: Id | null;   // null = ny vara
    group: "list" | "other";
  }> }
```

**Endpointen skriver ingenting.** Den läser katalogen och svarar. Alla ops skrivs
av klienten efter att du tryckt, vilket är skillnaden mot `/api/voice`: den har
ingen skärm och måste därför både bestämma och utföra.

Bilden krymps på telefonen före uppladdning — max 1600 px, JPEG — så en 12 MP
skärmdump inte blir en 8 MB POST i en butiksuppkoppling.

Klienten renderar namn, ikon, `hasAtHome` och "på listan" ur **sin egen**
katalog, som redan ligger i IndexedDB. Servern skickar bara id:n.

## 4. Bladet

`AiAddSheet` — helskärm, `useFocusTrap`, Escape stänger, `role="dialog"` och
`aria-modal`. Samma möbler som `RecipeAddSheet`, av samma skäl som det bladet
själv anger: en yta som kan lägga ett dussin varor på en lista ska bete sig som
sina syskon.

Öppnas från en knapp längst till höger *i* sökradens fält. Där bor redan "nämn en
sak och få den på listan", och skanningsknappen förblir ensam i tumbågen — den
kommentaren i `list-screen.tsx` försvarar sin egen singularitet, och det här är
en planeringsgest, inte en butiksgolvsgest.

### 4.1 Samla in

En stor mikrofonknapp, en textruta, en "Från bild"-knapp. Alla tre fyller samma
ruta och trycker på samma knapp.

**Mikrofonen** är webbläsarens `SpeechRecognition` med `lang="sv-SE"`,
`interimResults` som strömmar in i textrutan medan du pratar, tryck igen för att
sluta. Saknas API:t ritas knappen inte alls — en knapp som inte kan fungera är
värre än ingen knapp. Ingen ljudfil lämnar telefonen, ingen ny nyckel, ingen ny
kostnad.

**Bilden** är `<input type="file" accept="image/*">`, som ger fotobiblioteket
eller kameran på båda plattformarna, plus inklistring av en bild från urklipp.
Det här är den *garanterade* vägen in, inte reservvägen — se §5.

### 4.2 Granska

`RecipeAddSheet`s radmarkering, nästan ordagrant: kryssruta, namn, mängd högerst,
märken. Listgruppen först, "Också på bilden" under.

| Märke | Förbockad? | Varför |
|---|---|---|
| `NY VARA` | ja | Skapas i Övrigt vid bekräftelse, som receptvägen. En skärmdump från Bring består till stor del av ord den här katalogen aldrig sett; skyddet mot en permanent skräpvara är att du tittar rakt på den. |
| `PÅ LISTAN` | **nej** | Att lägga till något som redan ligger där är inte ett no-op: `applyOpToDatabase` drar tillbaka ett köp av samma vara från senaste halvtimmen (`RETRACT_WINDOW_MS`). Ett förbockat sådant kryss raderar tyst köphistorik. |
| `HAR HEMMA` | ja | Bara information här. Du har fotograferat en lista — då menade du saltet. |

Ingen kylskåpsgissning på den här vägen. `probablyStillHave` finns för att ett
recept *härleder* sina ingredienser; här har någon uttryckligen räknat upp dem,
och att gissa bort en av dem vore att svara på en fråga som inte ställdes.

Bekräftelseknappen: `Lägg till N varor`, avstängd på noll.

## 5. Delmålet, och konflikten som måste sägas högt

Ett manifest får ha **ett** `share_target`. Ert är upptaget av
`/recept/importera`. Bilder kräver dessutom `method: "POST"` med
`multipart/form-data`, och en App Router-sida kan inte ta emot POST.

Lösningen är ett POST-mål på `/dela` — en **route handler**, `src/app/dela/route.ts`,
inte en sida. Route handlers tar POST, och en delning som följer en 303 landar
där den ska:

- Kom det en fil: lägg den i `shareInbox` (§5.1) och skicka vidare till
  `/?ai=share&t=<token>`.
- Kom det en länk: skicka vidare till `/recept/importera?url=…&text=…`.

Receptdelningen fungerar alltså precis som förut, bara via ett annat rör.

**Service workern rörs inte.** Det första utkastet lade triagen i `fetch`-
hanteraren med filen i IndexedDB, och det var fel instrument. `sw.js` egen
kommentar beskriver hur en dålig worker blir "a self-inflicted,
unrecoverable-from-inside state" — appens kod kör aldrig, så den kan inte ens
avregistrera sig. Att lägga delningsvägen där hade satt en ny, sällan körd
kodväg i den enda fil i repot som kan låsa hela appen. En route handler kan
felas om, testas rakt av, och kräver ingen aktiv worker för att delning ska
fungera första gången appen installeras.

### 5.1 `shareInbox`

`src/lib/services/share-inbox.ts`: en `Map` från slumptoken till
`{ data, mediaType, actor, createdAt }`, med tio minuters livslängd och plats
för fem poster (äldst ryker först). Processlokal, vilket räcker — hushållet kör
en container, och en token som inte överlever en omstart kostar en ny delning.

`take(token, actor)` **tömmer** posten och vägrar lämna ut den till en annan
användare än den som delade. Bilden når alltså aldrig disken, och kan inte hämtas
två gånger.

Det här gäller **bara Android**. iOS har inget stöd för Web Share Target över
huvud taget — en installerad PWA kan inte dyka upp i iOS delningsmeny. Därför är
filväljaren och inklistringen den garanterade vägen och delmålet grädden.

## 6. Bekräftelsen

Klientsidan, genom `list-client`s befintliga `dispatch` — alltså optimistiskt och
med utkorgen bakom sig, till skillnad från receptskärmen som går via `/api/ops`.
Väl igenom tolkningen är det här en vanlig tryckning.

Per bockad rad:

1. `ensureVara(name)` för nya varor — som redan vägrar återskapa en vara som
   finns, eftersom `create_catalog_item` ersätter raden rakt av och hade nollat
   någons omsortering på `/varor`.
2. `add_item`.
3. `set_amount`, när en mängd lästes.

Tidsstämplarna måste vara strikt växande genom `nextOpTimestamp`, precis som i
`voice-ingest.ts`: ett dussin ops föds inom samma millisekund och två ops med
samma stämpel kan inte ordnas av last-write-wins.

## 7. Vad som lämnas orört

**`/api/voice` och `/api/alexa` byter inte motor.** De svarar en människa som
står i köket och väntar på en talad bekräftelse; ett modellanrop lägger en
sekund och ett nytt felläge i den hetaste vägen. Och de har ingen skärm, så
regeln "rösten skapar aldrig en vara" måste stå kvar där. Den nya vägen får gissa
hårdare just för att den har en skärm som fångar gissningen.

## 8. Tester

- `parse.test.ts` — SDK:n mockad som i `llm.test.ts`: ingen nyckel ⇒ inget
  anrop, vägran ⇒ `null`, kastat fel ⇒ `null`, och förfrågans form.
- `ai-add.test.ts` — ett Bring-format svar som fixtur: gruppering, dedupe,
  redan-på-listan, ny vara, mängder, och textreservvägen utan nyckel.
- Playwright — bladet mot en stubbad `/api/ai/parse`: bocka bort, bekräfta,
  brickorna på listan.
- `SpeechRecognition` får inga enhetstester. Den ägs av webbläsaren och skriver
  bara i textrutan, och textrutan är testad.

## 9. Medvetet utanför

Redigering av en felläst rad i dialogen (`/varor` byter namn och slår ihop redan),
kylskåpsgissningen, en genväg på hemskärmen för röst, och varje ändring i
röstvägarna.

## 10. Det som behöver sägas i docs

Skärmdumpar går till Anthropic. Hushållets recept gör det redan, så gränsen är
inte ny — men den ska stå skriven i `docs/voice.md`s granne snarare än vara
underförstådd.
