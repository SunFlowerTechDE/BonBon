# @bonbon/zvt-spike

M0-Spike: Kartenzahlung gegen das ZVT-Mock-Terminal auf Port 20007, später
gegen ein echtes CCV Base Next.

> **Gemessen ist der eigene Mock, kein Terminal.** Und der Mock entstand aus
> derselben Lesart der Spezifikation wie der Adapter — beide koennen
> gemeinsam falsch liegen, ohne dass ein Test das zeigt. Ein echtes CCV Base
> Next wurde nie angefasst. Siehe CLAUDE.md, „Gemessen oder angenommen".

```
pnpm zahlung                        3,80 EUR an localhost:20007
pnpm zahlung -- --betrag 940        anderer Betrag, in Cent
pnpm zahlung -- --host 192.168.1.9  gegen ein echtes Terminal
pnpm zahlung -- --storno 0001       Storno einer Belegnummer
pnpm zahlung -- --kassenschnitt     Kassenschnitt
```

Vorher das Terminal starten: `pnpm terminal` — Anleitung und Protokolldetails
stehen in [tools/mock-terminal/README.md](../mock-terminal/README.md).

## Was der Spike zeigt

Die vier Ausgänge einer Kartenzahlung und wie eine Kasse mit jedem umgeht:

| Ausgang | Kunde hat bezahlt? | Kasse tut | Exit |
|---|---|---|---|
| `approved` | ja | Bon als bezahlt abschließen | 0 |
| `declined` | sicher nicht | Bon bleibt offen | 1 |
| `aborted` | sicher nicht | wie `declined` | 1 |
| `unknown` | **nicht feststellbar** | erst auflösen | 3 |

Der `unknown`-Zweig ist der Punkt. Er darf nicht in einem `else` landen, das
„nicht bezahlt" bedeutet, und schon gar nicht in einem, das „bezahlt" bedeutet
(CLAUDE.md, Regel 15). Der Spike ruft dort `assertSettled()` auf und zeigt den
geworfenen `UnresolvedPaymentError` — die Zusicherung ist also nicht nur
dokumentiert, sondern vorgeführt.

Danach geht er den dokumentierten Weg 3: Storno. Ist eine Belegnummer bekannt,
storniert er vorsichtshalber und zeigt am Ergebnis, ob es tatsächlich eine
Zahlung gab.
