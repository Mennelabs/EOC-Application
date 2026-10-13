# SMS and phone setup

Use Twilio for both texting and the phone line, and give each county its own verified toll-free number. That is the simplest path: one vendor, one API, no carrier campaign registry for the pilot, and the strongest documentation. The answers below are ready to paste into Twilio's toll-free verification form; bracketed items come from the county.

## Why Twilio

| Option | Strength | Trade-off |
| --- | --- | --- |
| **Twilio (recommended)** | SMS, MMS photos, voice and IVR (Studio) in one account; English and Spanish text-to-speech and speech recognition; APIs for registering each county as a customer | Not the cheapest per message |
| Bandwidth | Owns its own carrier network; widely used in public safety | More engineering for IVR |
| AWS End User Messaging + Amazon Connect | Same cloud as the product | More setup; two separate services |

## Number strategy

- **Pilot: one verified toll-free number per county.** Verification is per number with the county's details. It avoids the 10DLC brand and campaign registry, supports texting and calling on the same number, and handles surges well.
- **Later, optional: a local 10DLC number** if a county wants a local area code. That needs a brand registration (county as a government entity) and a campaign.
- **Do not describe this as emergency alerting.** Carriers reject campaigns that look like emergency alerts unless they go through extra review (Twilio error 30929). These messages are two-way damage reporting, help requests and status updates. Real alerts go through the county's own Wireless Emergency Alerts tool (PUB-11).
- **Who is the "business":** as the software vendor, Mennelabs submits the county's legal name, tax ID, website and contact, not its own. Mennelabs registers its own number only for demos and exercises.
- **Start early.** Verification takes time and rejections add rounds. Submit as soon as a pilot county signs.

## What the county must provide

- [ ] Legal name exactly as on IRS records, and its EIN
- [ ] Official website (the county's own domain)
- [ ] Physical address
- [ ] Contact person: name, title, email on the county domain, phone
- [ ] An SMS privacy policy and SMS terms page on the county website (Mennelabs supplies the text below). Terms must be on the same domain as the county website.
- [ ] Approval of the sample messages and keywords

## Toll-free verification answers

| Field | Answer to submit |
| --- | --- |
| Legal name and DBA | \[County legal name\] DBA \[County\] Emergency Management |
| Business registration number | \[County EIN\] |
| Website | \[https://county-domain/emergency\] |
| Address | \[County EOC street address, city, state, ZIP\] |
| Business contact | \[Name, title, county email, phone\] |
| Notification email | \[Mennelabs operations email\] |
| Use cases | CUSTOMER\_CARE; PUBLIC\_SERVICE\_ANNOUNCEMENT |
| Message volume (monthly) | 100,000 (sized for a disaster month; normal months are far lower) |
| Opt-in types | Via Text; Web Form; Mobile/QR Code; Verbal |
| Age-gated content | No |
| Embedded links | Yes, only on the county's or product's own domain; no public link shorteners |
| Embedded phone numbers | Yes: 911 and the county help line |
| Privacy policy URL | \[https://county-domain/sms-privacy\] |
| Terms URL | \[https://county-domain/sms-terms\] |

**Use case summary: CUSTOMER\_CARE**

> &#91;County\] Emergency Management uses this number so residents affected by a disaster can report damage to their home and ask for help (shelter, food, cleanup) by text or phone. Residents start the conversation by texting a keyword such as DAMAGE or DAÑOS. The county replies with one question at a time, sends a reference number, and sends follow-up messages about that resident's own report and requests, such as when a volunteer crew is scheduled. Messages are sent only to residents who started a conversation or agreed to updates. No marketing.

**Use case summary: PUBLIC\_SERVICE\_ANNOUNCEMENT**

> During an active disaster, residents can text SHELTER or REFUGIO with their ZIP code to receive the nearest open shelters and help sites. Residents who opt in to updates receive notices when sites open, close or fill up in their area. These are informational replies, not emergency alerts; emergency alerts are sent separately through the county's alert system.

**Opt-in description (message flow)**

> Residents opt in four ways. (1) Via text: the resident texts a keyword (DAMAGE, DAÑOS, SHELTER, REFUGIO) to \[toll-free number\], which is published on the county website, social media, flyers and door hangers. The first reply confirms the program, frequency, HELP and STOP. (2) Web form: on the county's report page, the resident enters a mobile number and checks an unchecked box: "Text me updates about my report from \[County\] Emergency Management. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help." with links to the SMS terms and privacy policy. (3) QR code: flyers and door hangers carry a QR code that opens a text to \[toll-free number\] with the keyword prefilled. (4) Verbal: a trained volunteer or call-center agent helping a resident asks, "May we text you updates about your report?" The answer, agent and time are recorded in the system before any message is sent. Screenshots: \[URL with screenshots of the web form and flyer\].

**Sample messages**

1. CUSTOMER\_CARE: "\[County\] Emergency Mgmt: Thanks for reporting damage. Your reference number is KXMR-4827. This does not send emergency help. In danger now? Call 911. Reply STOP to opt out."
2. CUSTOMER\_CARE: "\[County\] Emergency Mgmt: What kind of home is it? Reply 1 House, 2 Apartment or condo, 3 Mobile or manufactured home, 4 Other, 0 Don't know."
3. CUSTOMER\_CARE: "\[County\] Emergency Mgmt: A volunteer cleanup crew is scheduled for your home on \[date\] in the morning. Questions? Call \[county help line\]. Reply STOP to opt out."
4. PUBLIC\_SERVICE\_ANNOUNCEMENT: "\[County\] Emergency Mgmt: Nearest open shelter: \[name\], \[address\], open 24 hours, pets allowed. More sites: \[county-domain/help\]. Reply STOP to opt out."
5. CUSTOMER\_CARE (Spanish): "\[Condado\] Manejo de Emergencias: Gracias por reportar daños. Su número de referencia es KXMR-4827. En peligro ahora? Llame al 911. Responda ALTO para cancelar."

**Automatic replies and keywords**

| Item | English | Spanish |
| --- | --- | --- |
| Opt-in confirmation | \[County\] Emergency Mgmt: You're signed up for messages about your disaster report. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out. | \[Condado\] Manejo de Emergencias: Recibirá mensajes sobre su reporte. La frecuencia varía. Pueden aplicar tarifas. Responda AYUDA para ayuda, ALTO para cancelar. |
| HELP reply | \[County\] Emergency Mgmt disaster help line. Call \[county help line\] or visit \[county-domain/help\]. In danger now, call 911. Reply STOP to opt out. | Línea de ayuda de \[Condado\]. Llame al \[número\] o visite \[county-domain/ayuda\]. En peligro, llame al 911. Responda ALTO para cancelar. |
| STOP reply | \[County\] Emergency Mgmt: You're unsubscribed and will get no more messages. Reply START to rejoin. | \[Condado\]: Ya no recibirá mensajes. Responda START para volver. |
| Opt-in keywords | DAMAGE, SHELTER, START | DAÑOS, DANOS, REFUGIO (AYUDA is reserved for help) |
| Opt-out keywords | STOP, END, CANCEL, UNSUBSCRIBE, QUIT, STOPALL | ALTO, PARAR, CANCELAR |
| Help keywords | HELP, INFO | AYUDA |
| SHELTER / REFUGIO reply (layer 3; the keyword now takes a ZIP code) | \[County\] Emergency Mgmt: Open sites nearest Harmon City (63005): Harmon High School gym (shelter) (0 km away): 400 Schoolhouse Rd, Harmon City, 63005; Open 24 hours; service animals only; wheelchair accessible. … (up to three sites, one per line) · second text: More: \[county-domain/help\]. In danger now, call 911. Reply STOP to opt out. | \[Condado\]: Sitios abiertos cerca de Cedar Ridge (63002): … · Más: \[county-domain/help\]. En peligro, llame al 911. Responda ALTO para cancelar. |
| SHELTER without a place | … Text SHELTER and your ZIP code for the nearest open sites, for example SHELTER 63001. | … Envíe REFUGIO y su código postal para los sitios abiertos más cercanos, por ejemplo REFUGIO 63001. |
| Reply to a staff update (FL-11) | \[County\] Emergency Mgmt: Thanks, your message was added to report ABCD-2345. A person will read it. Urgent? Call \[county help line\]. In danger now, call 911. | \[Condado\]: Gracias, su mensaje se añadió al reporte ABCD-2345. Una persona lo leerá. ¿Urgente? Llame al \[número\]. En peligro, llame al 911. |
| Staff update (FL-11; sent only with opt-in) | \[County\] Emergency Mgmt (\[sender\]) about report ABCD-2345: \[plain text\] Reply to this text to answer. In danger now? Call 911. Reply STOP to opt out. | \[Condado\] (\[remitente\]) sobre el reporte ABCD-2345: \[texto\] Responda a este texto. ¿En peligro? Llame al 911. Responda ALTO para cancelar. |
| Sharing withdrawal keyword (layer 3, **pending Adam's review before the carrier submission**) | NOSHARE + reference number, e.g. NOSHARE ABCD-2345 | NOCOMPARTIR + número de referencia (NOSHARE also works) |
| NOSHARE reply | \[County\] Emergency Mgmt: Your report ABCD-2345 is no longer shared with partner organizations. Any that had it were told to delete it. Reply STOP to opt out. | \[Condado\]: Su reporte ABCD-2345 ya no se comparte con organizaciones asociadas. A las que lo tenían se les pidió borrarlo. Responda ALTO para cancelar. |

Spanish characters such as ñ and accents switch a text to a shorter segment length (70 characters), so Spanish replies cost more segments; keep them short.

## Text for the county's SMS privacy policy page

> &#91;County\] Emergency Management uses text messages only to help residents report disaster damage, request help and get updates about their own report. Mobile numbers and text opt-in information are not shared with or sold to third parties for marketing. They are shared only with service providers that deliver messages and, with your consent, with relief organizations helping you. Message frequency varies. Message and data rates may apply. Reply STOP to opt out at any time or HELP for help.

## Text for the county's SMS terms page

> Program: \[County\] Emergency Management disaster reporting and help messages. Text DAMAGE or DAÑOS to \[toll-free number\] to report damage, or SHELTER or REFUGIO with your ZIP code for nearby help. Message frequency varies by event and by your requests. Message and data rates may apply. Reply HELP for help or STOP to cancel. Carriers are not liable for delayed or undelivered messages. This service does not dispatch emergency help; call 911 in an emergency. Privacy: \[county-domain/sms-privacy\].

## Phone line (IVR)

- **Build:** Twilio Studio on the same toll-free number. English or Spanish menu, speech or keypad answers, the same question graph as text (CHN-05), and transfer to a person at any time.
- **No carrier registration for incoming calls.** For outgoing callbacks, register the county's caller ID in Twilio Trust Hub so calls show as verified and display the county's name.
- **Recorded greeting:** "\[County\] Emergency Management disaster help line. If anyone is in danger, hang up and call 911."

Sources: [Twilio A2P 10DLC required information](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/collect-business-info) · [Twilio toll-free verification required information](https://support.twilio.com/hc/en-us/articles/13264118705051-Required-Information-for-Toll-Free-Verification) · [Twilio error 30929](https://www.twilio.com/docs/api/errors/30929)
