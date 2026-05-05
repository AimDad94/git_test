// Spec-baserede klassifikationsregler. Decision order matcher specifikationen i
// spam-filter-spec.md. Returnerer enten {verdict, category, reasons} eller null
// hvis ingen regel matcher (fall-through til scoring + LLM).

// ----- Domæne-blocklists -----

const INTERNAL_DOMAINS = new Set([
  // 'voresdigital.dk' bevidst udeladt — formular-afsendere er ægte leads og
  // håndteres af det eksisterende form-sender-override.
  'vores-mediehus.dk', 'vores-digital.dk',
  'voresdigital.eu1.r.hs-inbox.com'
]);

const NOREPLY_PREFIXES = [
  'no-reply', 'noreply', 'no_reply', 'donotreply', 'do-not-reply',
  'mailer-daemon', 'postmaster', 'notifications', 'notification',
  'auto-confirm', 'bounce', 'mailer', 'wetransfer'
];

const FB_AUTO_DOMAIN_PARTS = ['mail.instagram.com', 'facebookmail.com'];

const PR_DOMAINS = new Set([
  'publicity.dk', 'ritzau.dk', 'helpagency.dk', 'help-pr.dk', 'mannov.dk',
  'essencius.dk', 'pressconnect.dk', 'mynewsdesk.com', 'mynewsdesk.dk',
  'mch.dk', 'newsdesk.com', 'prnewswire.com', 'businesswire.com',
  'getapress.dk', 'pressfeed.dk', 'mynewsletter.dk', 'pr.dk',
  'rostrapr.com', 'perfektapr.dk', 'epicent.dk', 'morsingpr.dk',
  'klixkommunikation.dk', 'primetime.dk', 'radiuscph.dk',
  'rudpedersen.com', 'sending.news', 'prconsultancy.org',
  'muusmann-forlag.dk', 'meyermedier.dk', 'knowledgepartner.dk',
  'digitalpr.dk', 'heibelgodsk.dk', 'pressemeddelelser.net',
  'pressat.net', 'icontactmail3.com', 'cision.com'
]);

const SEO_SPAM_DOMAINS = new Set([
  'bazoom.com', 'dzhingarov.com', 'arghagency.com', 'kirik.pro',
  'tiendanube.com', 'eu-west-1.amazonses.com', 'atlasseo.co.uk',
  'organicwebsolution.com', 'worldreachseo.com', '2t-digital.com',
  'webtechresearch.com', 'meidatools.com', 'meidastop.net',
  'ozurich.net', 'cnnamedns.net', 'seoblue.nl', 'kaboozt.com',
  'harrisinteractives.com', 'outreachproapp.co', 'lazaridis-media.com',
  'salesdripmail.co', 'presswhizz.net', 'prospectlabagency.co',
  'outreachgridhq.co', 'outboundhqclub.com', 'leadbursthq.com',
  'marketingseoservice4.com', 'innocodesmartcity.com',
  'bettgameday.com', 'audiencr.com', 'audiencr-media.co',
  'eubusinessnews-mail.com', 'slotsspot.com',
  'linkbuildingservices.online', 'seo.casino', 'jmitadvice.tech',
  'nuukmedia.com', 'qrcodeveloper.com', 'esbo.ltd', 'cndomainnames.net',
  'linkjuiceclub.com', 'netpeakagency.net', 'thetechnobrand.com',
  'wizemarketers.com'
]);

const COLD_OUTREACH_DOMAINS = new Set([
  'pritiinternational.com', 'pritihome.com', 'e.promogiftistanbul.com',
  'promogiftistanbul.com', 'mscsupplygroup.com', 'xmoreadybags.com',
  'caiva.com', 'cmswebsiteservices.com', 'feduro.net',
  'marketing1.emailrolling.com', 'edmprocontact.com',
  'abnormaltransports.com', 'event.dtctrademarketing.com',
  'campaign.dtctrademarketing.com', 'dtctrademarketing.com',
  'event.emaildps.com', 'emaildps.com', 'tsict.com',
  'plasticmolds8.top', 'padjinou.com', 'hardfindtronics.com',
  'makkastones.com', 'rotomoldk.com', 'cooloutdoor.rotomoldk.com',
  'laniakeaenergy.com', 'milkoexport.com', 'rrrontabags.info',
  'nbmbms.com', 'hystou.com', 'ds-industrial.com', 'zymboitalia.it',
  'toughcctv.com', 'kdhangers.com', 'agorize.com', 'promote.emaildps.com',
  'chinaedmexchange.com', 'asourcingic.com', 'suvsyselects.com',
  'guandeng.com', 'led.guandeng.com', 'panamich.com', 'wya-america.us',
  'xinyaonline.com', 'factorymadecn.com', 'boruang.com', 'tanpromo.com',
  'hizbao.com', 'vip.hizbao.com', 'led.tiaoye.com', 'tiaoye.com',
  'china-wheelchair.com'
]);

const FB_PHISHING_DOMAINS = new Set([
  'securitybusinessmeta.com', 'metabusiness.com',
  'assistant-advertise-business-.com', '1onica.com',
  'business-support-assistance.com', 'bfsdn.life',
  'metamail-support.com', 'business-manager-support.com',
  'forbusiness-support.com', 'advertising-assistance-team.com'
]);

const KNOWN_BAD_DOMAINS = new Set([
  'taxipoet.com', 'designbyansley.com', 'ensigna.com.br', 'colmar.be',
  'lancedesigns.co.za', 'elevateweb.co.uk', 'deltainstore.co.za',
  'denisschild.de', 'janawelch.de', 'fnep.co.za', 'cellular4africa.com',
  'employmenttribunal.gov.mv', 'grupo-dym.com', 'mymail.lausd.net',
  'kaffelogen.com', 'canyou.com', 'hostaway.net.au', 'firemail.de',
  'burnsdrillingsupply.com', 'betalt.lt', 'copyrightagent.com',
  'disruptoruni.pl', 'venturescope.pl', 'gghs174a-9l.org',
  'premlike.com', 'grupomafro.com.br', 'home.se',
  'openbare-verkopen.be', 'vendio.com'
]);

const KNOWN_BAD_SENDERS = new Set([
  'najibmouhajiir@gmail.com', 'sofia.zinchenkooo@gmail.com',
  'seymour.conner@linkbuildingservices.online', 'vika@seo.casino',
  'anastasia@seo.casino', 'scott@jmitadvice.tech',
  'fredrik@nuukmedia.com', 'paula@qrcodeveloper.com',
  'outreach@esbo.ltd', 'carolgrogerssen@gmail.com',
  'brainjackobaa@gmail.com', 'export@promote.emaildps.com',
  'sales07@hystou.com', 'victor@ds-industrial.com',
  'export1@zymboitalia.it', 'export2@zymboitalia.it',
  'daniel@toughcctv.com', 'yang@kdhangers.com', 'zoeyemm@163.com',
  'gxmijin02@163.com', '13905748002@163.com',
  'alexander.young@agorize.com', 'naoresponda@grupomafro.com.br',
  'oficial@kaffelogen.com', 'contact@premlike.com',
  'skyartlimited@gmail.com', 'moujtahidicloud@gmail.com',
  'usmo2024@hotmail.com', 'norely@canyou.com',
  'support@home.se', 'a22a@hostaway.net.au',
  'info@openbare-verkopen.be', 'email.services@vendio.com',
  'meta@metamail-support.com', 'gbuffalo97@gmx.com',
  'facebook@business-manager-support.com',
  'facebook@forbusiness-support.com',
  'facebook@advertising-assistance-team.com',
  'wikfinland@gmail.com', 'namforas@gmail.com',
  'post@laperlasaksvik.no', 'hcluvaezjarl@gghs174a-9l.org',
  'sandrina.omaru2022@gmail.com', 'davalenstrerob@durango.gob.mx',
  'eziobus@icloud.com', 'szymon.kudra@venturescope.pl',
  'sk@pressemeddelelser.net', 'wire@pressat.net',
  'info+noisepr.com@icontactmail3.com', 'sofia.slotsspot@gmail.com',
  'thomas@cndomainnames.net', 'denmark@linkjuiceclub.com',
  'ihor_malitskyi@netpeakagency.net', 'mikebrits@thetechnobrand.com',
  'timj.info@gmail.com', 'lily.welch@wizemarketers.com',
  'usmanbhte003@gmail.com', '3ellcompany1@gmail.com',
  'export@event.chinaedmexchange.com', 'selena@news.asourcingic.com',
  'gaby@news.suvsyselects.com', 'lights@led.guandeng.com',
  'sales@panamich.com', 'sales11@wya-america.us',
  'alicehuang0317@gmail.com', 'sales@xinyaonline.com',
  'frank@factorymadecn.com', 'boruang@boruang.com',
  'sales@tanpromo.com', 'vip@vip.hizbao.com', 'inforequest@gates.com',
  'advertisement-management-mt@firemail.de',
  'rasslebbigbke1970@gmail.com', 'service@burnsdrillingsupply.com',
  'k.bongiorni@betalt.lt', 'case@copyrightagent.com',
  'tomasz.fiszka@disruptoruni.pl',
  // Repeat-rant/conspiracy senders
  'hp45@live.dk', 'hans.preben.jensen@gmail.com',
  'sdrzen@yahoo.com', 'lars.kiil.67@gmail.com',
  'heijen5761@gmail.com'
]);

// ----- Domæne-regex -----

const COLD_DOMAIN_REGEX = [
  /^edm\./i, /\.cn$/i, /@163\.com$/i, /\.su$/i, /emailrolling/i,
  /edmprocontact/i, /edmautopro/i, /edmboost/i, /edmexportmarket/i,
  /\.jambyl\./i, /dtctrademarketing/i, /abnormaltransports/i,
  /weblinks\.agency/i, /\.top$/i, /rotomoldk/i, /plasticmolds/i,
  /tradem(arket|ing)\.com/i, /rrrontabags/i
];

const FB_PHISHING_DOMAIN_REGEX = [
  /securitybusinessmeta/i, /businessmeta\.com$/i, /assistant-advertise/i,
  /meta-?business/i, /-meta\.com$/i, /business-support-assistance/i
];

// ----- Subject regex (alle matches mod lowercased subject) -----

const PR_SUBJECT = [
  /^pm\s*[\-:]/i, /pressemeddelelse/i, /pressemeddelse/i,
  /pressemeddelelser/i, /presseinvitation/i, /pressem\.\s/i,
  /^press release/i, /press invitation/i, /^pressrelease/i,
  /opsummering af pressemeddelelser/i,
  /^prm[:\s\-]/i, /^pr\s*[:\-]\s/i, /^p\.m\.\s/i,
  /^pr\s+[a-zæøå]/i, /^\[\s*presse\s*\]/i, /^presse\s*[:\-]/i,
  /^navnenyt\b/i
];

const SEO_SUBJECT = [
  /guest post/i, /sponsored post/i, /sponsored content/i,
  /sponsored article/i, /sponsored placement/i, /sponsorerede indlæg/i,
  /sponsoreret indhold/i, /^reklame\s*\/\s*sponsoreret/i,
  /^reklame.*sponsoreret/i, /publication proposal/i,
  /business opportunity/i, /advertising opportunity/i, /link building/i,
  /collaboration proposal/i, /act now before/i, /join this month/i,
  /invaluable proposition/i, /partnership opportunity/i, /paid post/i,
  /advertorial/i, /gæsteindlæg/i, /article order on/i,
  /a new article publication on/i, /a new collaboration with vores/i,
  /open for paid collaboration/i, /a new query about a publication on/i,
  /^en ny forespørgsel om en (udgivelse|publikation)/i,
  /^et nyt samarbejde med vores/i, /genindførelse af udgivelsen/i,
  /reminder of cooperation/i, /cooperation offer/i,
  /collaboration offer/i, /follow up partnership inquiry/i,
  /parthnership with/i, /partnership with vores/i,
  /cooperation with weblinks/i, /publish.*on your blog/i,
  /sharing my work on your platform/i,
  /looking for a platform to publish/i, /high-quality articles/i,
  /lot.?s of issues in your website/i, /errors? on your/i,
  /re.?design and development at the best price/i,
  /advertising enquiry/i, /search performance report/i,
  /great content ideas for your/i, /request to publish content/i,
  /\bpris.*artikel.*vores/i, /\bprisen for.*artikel/i,
  /website (audit|errors|issues) on/i,
  /\bcan i (share|publish|contribute)\b/i,
  /hoping for a chance to contribute/i,
  /\b(i want|i'?d like|want) to publish (an? )?article/i,
  /\binquiry about vores/i, /\binquiry about voresby/i,
  /inquiry about voresdigital/i, /inquiry about https?:\/\/vores/i,
  /^inquiry$/i, /^inquiry\s/i, /^request to publish/i,
  /quick follow.?up on my last email/i,
  /^follow.?up\s*[\-:]/i, /^follow.?up\s*-/i,
  /\bguest compensation\b/i, /\bwin.win\b.*samarbejde/i,
  /forespørgsel om.*samarbejde/i,
  /\b(article|content) (placement|insertion)/i,
  /^article placement request/i, /\barticle on your/i,
  /^interested in publishing/i, /^interested in featuring/i,
  /^interested in (sharing|sharing my|share)/i,
  /placement request/i, /\bdomainregistrychina/i,
  /editorial post proposal/i, /^nomination received for vores/i,
  /^att\.?\s+vores\s/i, /^att\s+vores\s.*redakt/i,
  /improve your online presence with/i,
  /trustpilot review management/i,
  /your competitors are winning with reviews/i,
  /\bartikelrækkefølge\b/i, /^artikelrækkefølge vedr/i,
  /\bcollaboration\s*-\s*natural links\b/i, /\bnatural links\b/i,
  /looking for permission to submit/i,
  /looking for a platform to showcase/i
];

const COLD_PITCH_SUBJECT = [
  /\brequest for quotation\b/i, /\bget a .* quotation\b/i, /^quotation\b/i,
  /\bsupplier\b.*\b(china|factory|manufacturer)\b/i,
  /\bfactory direct\b/i, /\bbag manufacturer\b/i,
  /\b(plastic|lithium|smartphone|backpack|brake|car phone|magnetic)\b.*\b(supplier|manufacturer|holder|solution)\b/i,
  /high.performance .* manufacturer/i, /premium .* supplier/i,
  /\bnew (furniture |order)\b/i, /production partnership/i,
  /stay ahead in the competition/i, /semiconductor solutions/i,
  /derila pude/i, /\bderila\b/i,
  /^supply\s+(invitation|paper|electronic|product|material)/i,
  /transport offer/i, /oversize transport/i,
  /unlock potential with/i, /\bfabric.*manufacturer\b/i,
  /\boem manufacturer\b/i, /carbon & kevlar/i,
  /\bmarbre\b/i, /\bgranite\b.*\b(supplier|export)\b/i,
  /\bmicrocontroller\b/i,
  /\bembedded\b.*\b(supplier|chip|microcontroller)\b/i,
  /\boem\b.*\b(boat|moq|shipping)\b/i, /\blow moq\b/i,
  /\bshipping rate\b/i, /rapid prototyping/i, /^email lists\b/i,
  /\bvalid email\b.*\bany country\b/i,
  /\b(craft|fishing|inflatable) boat\b/i, /^lontrend\b/i,
  /pan tilt solution/i, /\bdiaper\b.*\b(supplier|caddy|basket)\b/i,
  /^personalised customised/i, /^re:?\s*personalised customised/i,
  /customised\s+(bag|product|gift)/i,
  /\bsolar carport\b/i, /\benergimirakel\b/i,
  /lagerbeholdning(en)? i danmark/i,
  /\bhigh quality\b.*\b(basket|bag|caddy|product)\b/i,
  /\bpaper cup manufacturer/i, /\bd rings\b.*\bo rings\b/i,
  /\bleisure chair\b/i, /\blivingroom chair\b/i,
  /\bshopping bag.*order/i, /order popular shopping bag/i,
  /^rfq\s/i, /^rfq:/i, /\belectronic component(s)? inquiry\b/i,
  /\bvoicemail message\b.*\bsalg\b/i
];

const FB_PHISH_SUBJECT = [
  /sags.?id\s*\[\d+\]/i, /sagsnr\.?\s*\d+/i,
  /er.*blevet\s+sortlistet/i,
  /side\s+.*\s+er\s+(netop\s+)?blevet/i,
  /\bdin (virksomhedsside|side|konto) er.*(begrænset|deaktiveret|sortlistet)/i,
  /(advertising|copyright) (policy )?violation/i,
  /copyright (violation|infringement)/i,
  /ophavsret(skrænkelse)?/i, /overtrædelse af ophavsret/i,
  /krænker ophavsretten/i, /billeder og videoer.*krænker/i,
  /\bintellektuelle ejendomsret/i, /i strid med intellektuelle/i,
  /ad account.{0,25}(attention|disabled|warning|review|problem|needs)/i,
  /(immediate|urgent) action.{0,25}required/i,
  /page.{0,20}(restricted|disabled|removed|suspended)/i,
  /policy violation.{0,20}(detected|observed)/i,
  /wurde als dauerhaft deaktiviert/i,
  /(re:?\s*)?vigtigt.*godkend.*facebook/i,
  /godkend\s+vores\s+facebook/i,
  /^(sv|re):?\s*facebook anmodning/i, /^facebook anmodning/i,
  /din konto.{0,20}deaktiv/i, /your ad account needs/i,
  /your account will be deactivated/i,
  /unauthorized use of (trademark|trademarks)/i,
  /du mister adgangen/i, /mister adgangen til din konto/i,
  /venligst verificér din virksomhed/i,
  /aktivér.*lunar/i,
  /advarsel.*overtrædelse/i, /vigtig meddelelse.*overtrædelse/i,
  /community standards violations?/i, /standards violations/i,
  /vigtig meddelelse.*intellektuelle/i,
  /review required.{0,20}irregularities/i,
  /irregularities in policy compliance/i,
  /content review suggested/i,
  /\bfacebook advertising privileges\b/i,
  /annoncekonti.{0,30}begrænset/i,
  /we'?re sorry to say goodbye/i, /sorry to say goodbye/i,
  /^urgent[!:]\s*your/i
];

const DOMAIN_SCAM_SUBJECT = [
  /forlæng dit domæne/i, /domænenavnet udløber/i,
  /dit domænenavn er suspenderet/i, /dit domæne er .* suspend/i,
  /dit domænenavn er opsagt/i, /haster.*domæne/i,
  /sidste advarsel.*domæne.*blokeret/i,
  /(domain|domænenavn).*expir/i, /renew.*your.*domain/i,
  /tjek og verificér venligst/i,
  /handling påkrævet.*kontoen.*overtrædelse/i,
  /rapportnummer:\s*\d+/i,
  /\brisikerer at miste\b.*\b(domæne|hjemmeside)\b/i,
  /^fejl\s*[!:]/i, /automatisk fornyelse.*fejl/i,
  /fornyelse af domænet/i, /fornyelse af dit domæne/i,
  /domæne fornyelse/i, /domæne renewal/i,
  /gå ikke glip af din hjemmeside/i, /forny dit domænenavn/i,
  /vigtig meddelelse.*domæne/i
];

const DANISH_PHISH_SUBJECT = [
  /opdater (venligst |dine |din )?(betaling|faktureringsoplys|betalingsoplys|betalingskort)/i,
  /sidste påmindelse/i, /sidste advarsel/i,
  /\bbekræftelse af dine.*personlige (data|oplysning)/i,
  /bekræftelse af dine nye/i,
  /^(handling påkrævet|handling pkrvet)/i,
  /^vigtigt:.*handling/i,
  /vigtig meddelelse til kontoen/i,
  /vigtig meddelelse om din levering/i,
  /bekræft modtagelse af din pakke/i,
  /din pakke venter/i, /levering af din pakke/i,
  /pakke.*levering.*bekræft/i,
  /dit (abonnement|domæne|domænenavn|konto|indhold) (er|bliver|kan).{0,25}(deaktiv|udløb|suspend|opsagt|markeret|strid)/i,
  /\babonnementet (er|bliver) udløb/i,
  /^bemærk!\s*dit/i,
  /^nyt: vigtig information/i,
  /anmodning om tilbagebetaling/i,
  /indsend venligst din anmodning om tilbagebetaling/i,
  /review needed.{0,20}potential policy violation/i,
  /take immediate action to protect/i,
  /your advertising campaign violates/i,
  /vigtig meddelelse.*ændringer i brugervilkår/i,
  /opdatering af sikkerhed/i,
  /din refusionsfaktura/i,
  /gls.?meddelelse for forsendelse/i,
  /bekræft dit mobilnummer/i,
  /^action.?required.?vores/i,
  /^urgent notification/i,
  /your wallet (have|has) been compromised/i,
  /your personal data is at risk/i,
  /seneste opdateringer af vores brugervilkår/i,
  /\bdin pakke er på vej\b/i,
  /din pakke er.{0,20}forsink/i
];

const OFFICIAL_PHISH_SUBJECT = [
  /^retsbrev\b/i, /\bretsbrev nr/i,
  /politiets indkaldelse/i, /\bindkaldelsesbrev\b/i,
  /politiets hasteordre/i, /hasteordre/i,
  /\bhasteindkaldelse til retten\b/i,
  /til den pågældende adressat/i,
  /sygeforsikring(en)? !/i, /besked.*sygeforsikring/i,
  /refusion af medicinske/i,
  /\bskat\.dk\b/i, /^skat:.*tilbagebetaling/i,
  /\banklageskrift\b/i
];

const SCAM_419_SUBJECT = [
  /^greeting beloved/i, /^dear beloved/i, /^my dear (friend|beloved)/i,
  /\bbeloved one\b/i, /^urgent business/i,
  /^my name is.*lawyer/i, /^hello dear/i, /^greetings!?\s+i am /i,
  /^approval and signature required/i,
  /#ref\s*\{/i, /\bimmediate attention needed\b/i,
  /legal action from \w+ (pictures|inc|ltd|studios)/i,
  /\bdringende\b/i, /gute nachrichten/i,
  /^attention please\b/i, /^immediate attention/i,
  /is your email still active/i, /modtog du min tidligere besked/i,
  /^compliment of the day/i, /^investment\s*$/i,
  /^investment\b.*\b(opportunity|project|proposal)\b/i,
  /^investment opportunit/i, /^investment project/i,
  /family.*please view attachment/i, /^dear sir.*family/i,
  /\bwanaga\b/i, /\[spam\]/i, /^\[spam\]/i,
  /kontant donation/i, /illuminati/i, /illuminatikingdom/i,
  /notification award/i, /forretningsforslag.*privat besked/i,
  /^demande de devis/i, /^husen\s*\.org\s+is available/i,
  /\.org is available/i, /\.net is available/i
];

const SCAM_419_BODY = [
  /\bdear sir\/madam\b.*\b(deceased|inheritance|fund transfer|millions)\b/i,
  /sole beneficiary/i, /transfer of fund/i, /inheritance claim/i,
  /deceased (client|customer).*your country/i,
  /\$[\d.,]+\s*(million|usd)/i, /next of kin/i,
  /\bthe only (child|son|daughter) of (the )?(late|afdøde)/i,
  /jeg er det eneste barn af afdøde/i
];

const FILE_AUTO_SUBJECT = [
  /^you received \d+ document/i, /^wetransfer/i,
  /^your chatgpt code is/i, /^your.*verification code/i,
  /^kode til/i, /^bekræftelseskode/i,
  /quarantine notice/i, /^vores-mediehus quarantine/i
];

const URL_ONLY_SUBJECT = [/^https?:\/\/\S+\s*$/i];

// Generisk emoji/symbol-prefix der typisk indikerer junk
const SYMBOL_PREFIX_JUNK = [
  /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
  /^[⚠🚀🚨🔥🎉⭐💰💸💎📌💵📣]/u
];

// ----- Helpers -----

function getDomain(email) {
  if (!email) return '';
  const m = /@([^,;\s]+)/.exec(email.toLowerCase());
  return m ? m[1] : '';
}

function getLocalpart(email) {
  if (!email) return '';
  return email.toLowerCase().split('@')[0].split('+')[0];
}

function anyMatch(patterns, text) {
  for (const p of patterns) if (p.test(text)) return true;
  return false;
}

function firstMatch(patterns, text) {
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return p.source;
  }
  return null;
}

// ----- Decision order -----
//
// Returns either {verdict, category, reasons[]} eller null hvis ingen regel
// fanger ticket'en. Forventer { subject, bodyText, contact } som input.
//
// Matcher decision order fra spam-filter-spec.md, men:
//  - voresdigital.dk-formular-afsendere håndteres af eksisterende override
//    OVER dette regel-lag, så Internal/Automated for voresdigital er udeladt.
//  - Internal/Automated mappes til 'spam' (i stedet for egen bucket) med
//    kategori 'Automatisk', da det er noise vi ikke vil se.
//  - PR-distributions og PR-emner mappes til 'pressemeddelelse'-bucket
//    (ikke 'spam'), da brugeren har en separat presse-bucket.

function applySpecRules({ subject, bodyText, contact }) {
  const subj = (subject || '').toLowerCase();
  const body = (bodyText || '').slice(0, 600).toLowerCase();
  const email = (contact && contact.email || '').toLowerCase();
  const domain = getDomain(email);
  const local = getLocalpart(email);

  // 1. Internal / Automated (skipper voresdigital.dk - håndteres separat)
  if (domain && INTERNAL_DOMAINS.has(domain)) {
    return { verdict: 'spam', category: 'Automatisk', reasons: [`Internt domæne: ${domain}`] };
  }
  if (local && NOREPLY_PREFIXES.some(p => local.startsWith(p)) && domain !== 'voresdigital.dk') {
    return { verdict: 'spam', category: 'Automatisk', reasons: [`No-reply afsender: ${local}@…`] };
  }
  if (domain && FB_AUTO_DOMAIN_PARTS.some(p => domain.includes(p))) {
    return { verdict: 'spam', category: 'Automatisk', reasons: [`Facebook/Instagram automatisk: ${domain}`] };
  }
  if (anyMatch(FILE_AUTO_SUBJECT, subj)) {
    return { verdict: 'spam', category: 'Automatisk', reasons: ['Automatisk/file-share/quarantine emne'] };
  }

  // 2. Known Bad Sender
  if (email && KNOWN_BAD_SENDERS.has(email)) {
    return { verdict: 'spam', category: 'Kendt afsender', reasons: [`Kendt spam-afsender: ${email}`] };
  }
  if (domain && KNOWN_BAD_DOMAINS.has(domain)) {
    return { verdict: 'spam', category: 'Kendt domæne', reasons: [`Kendt spam-domæne: ${domain}`] };
  }

  // 3. Facebook Phishing
  if (domain && FB_PHISHING_DOMAINS.has(domain)) {
    return { verdict: 'spam', category: 'Facebook-phishing', reasons: [`FB-phishing-domæne: ${domain}`] };
  }
  if (domain && anyMatch(FB_PHISHING_DOMAIN_REGEX, domain)) {
    return { verdict: 'spam', category: 'Facebook-phishing', reasons: [`FB-phishing-mønster: ${domain}`] };
  }
  if (anyMatch(FB_PHISH_SUBJECT, subj)) {
    return { verdict: 'spam', category: 'Facebook-phishing', reasons: ['FB/Meta-phishing-emne'] };
  }

  // 4. Officiel impersonation
  if (anyMatch(OFFICIAL_PHISH_SUBJECT, subj)) {
    return { verdict: 'spam', category: 'Officiel impersonation', reasons: ['Politi/sundhed/skat-phishing-emne'] };
  }

  // 5. Domænesvindel
  if (anyMatch(DOMAIN_SCAM_SUBJECT, subj)) {
    return { verdict: 'spam', category: 'Domænesvindel', reasons: ['Domæne-fornyelses-svindel'] };
  }

  // 6. Dansk phishing
  if (anyMatch(DANISH_PHISH_SUBJECT, subj)) {
    return { verdict: 'spam', category: 'Dansk phishing', reasons: ['Dansk betaling/konto-phishing-emne'] };
  }

  // 7. 419-svindel
  if (anyMatch(SCAM_419_SUBJECT, subj)) {
    return { verdict: 'spam', category: '419-svindel', reasons: ['419-svindel-emne'] };
  }
  if (anyMatch(SCAM_419_BODY, body)) {
    return { verdict: 'spam', category: '419-svindel', reasons: ['419-svindel-tekst i body'] };
  }

  // 8. Kold pitch
  if (domain && COLD_OUTREACH_DOMAINS.has(domain)) {
    return { verdict: 'spam', category: 'Kold pitch', reasons: [`Cold-outreach-domæne: ${domain}`] };
  }
  if (domain && anyMatch(COLD_DOMAIN_REGEX, domain)) {
    return { verdict: 'spam', category: 'Kold pitch', reasons: [`Cold-outreach-domænemønster: ${domain}`] };
  }
  if (anyMatch(COLD_PITCH_SUBJECT, subj)) {
    return { verdict: 'spam', category: 'Kold pitch', reasons: ['Supplier/RFQ/kold-pitch-emne'] };
  }

  // 9. SEO/Backlink
  if (domain && SEO_SPAM_DOMAINS.has(domain)) {
    return { verdict: 'spam', category: 'SEO/Backlink', reasons: [`SEO-spam-domæne: ${domain}`] };
  }
  if (anyMatch(SEO_SUBJECT, subj)) {
    return { verdict: 'spam', category: 'SEO/Backlink', reasons: ['Link-bygnings-emne'] };
  }

  // 10. Pressemeddelelse
  if (domain && PR_DOMAINS.has(domain)) {
    return { verdict: 'pressemeddelelse', category: null, reasons: [`PR-distributions-domæne: ${domain}`] };
  }
  if (anyMatch(PR_SUBJECT, subj)) {
    return { verdict: 'pressemeddelelse', category: null, reasons: ['Pressemeddelelses-emne'] };
  }

  // 11. Junk
  if (anyMatch(URL_ONLY_SUBJECT, subj.trim())) {
    return { verdict: 'spam', category: 'Junk', reasons: ['URL-only emne'] };
  }
  if (anyMatch(SYMBOL_PREFIX_JUNK, subj)) {
    return { verdict: 'spam', category: 'Junk', reasons: ['Spam-symbol/emoji-prefix'] };
  }

  return null;
}

module.exports = { applySpecRules };
