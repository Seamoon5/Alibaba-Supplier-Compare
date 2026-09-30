/**
 * search.js — capture suppliers or products from an Alibaba results page.
 *
 * Runs inside the page (MAIN world) like harvest.js, so it must be entirely
 * self-contained: Chrome serialises the function and evaluates it in the page,
 * which means no imports and no closure references.
 *
 * Why this exists: the common way to source is to search Alibaba and compare the
 * results, not to land on one product page first. A capture tool that only
 * handles product pages therefore appears to do nothing at the exact moment the
 * user needs it.
 *
 * Two page shapes, two extraction strategies:
 *
 *   Suppliers tab (SearchScene=suppliers) — one card per COMPANY, holding the
 *   company name, its country flag, its credentials and a strip of its products.
 *   The whole card is one comparison row and the prices come from the product
 *   tiles, e.g. "US$1,250-4,500".
 *
 *   Products tab — one card per OFFER, where the card itself is the row.
 *
 * The supplier tab is extracted first and separately because it used to be read
 * with the product strategy. That produced a row whose "supplier name" was
 * "US$5,000" (a price-tier box read as a heading) and whose "country" was "US"
 * (matched out of the "US$" of the price). Both are fixed here, and the whole
 * thing is matched on LABEL TEXT and STRUCTURE rather than on Alibaba's class
 * names, which churn without warning.
 */

export function harvestSearchPage() {
  // ------------------------------------------------------------------ utils
  // Collapse runs of spaces and tabs but KEEP newlines. Alibaba cards separate
  // every field with a line break, and flattening them to spaces merges
  // neighbouring labels into each other ("$50K - $100K Min. order: ...").
  var clean = function (s) {
    return s
      ? String(s).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim()
      : '';
  };
  var text = function (el) {
    return el ? clean(el.innerText || el.textContent) : '';
  };
  var num = function (v) {
    if (typeof v !== 'string') return null;
    var m = v.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  var grab = function (source, re) {
    var m = String(source || '').match(re);
    return m ? m[1] : null;
  };
  var isVisible = function (el) {
    // Skip collapsed or virtualised rows: their text is not reliable.
    if (!el.getBoundingClientRect || !el.getBoundingClientRect().height) return false;
    return true;
  };
  var lines = function (s) {
    return String(s || '').split('\n').map(clean).filter(Boolean);
  };

  // ---------------------------------------------------------------- money
  // Alibaba writes USD as "US$", not "USD". A regex that only knows "USD"
  // silently finds nothing there, which is how a whole page ended up reported
  // as "no published price". Longest symbol first so "US$" wins over "$".
  var MONEY_RE = new RegExp(
    '(US\\$|C\\$|CA\\$|A\\$|AU\\$|HK\\$|S\\$|NT\\$|CN¥|RMB|CNY|JP¥|' +
      'USD|CAD|AUD|HKD|SGD|TWD|EUR|GBP|INR|PKR|SAR|AED|TRY|KRW|BRL|' +
      '\\$|¥|€|£|₹|₩)' +
      '\\s?(\\d[\\d,]*(?:\\.\\d+)?)' +
      '(?:\\s*[-–—~]\\s*(\\d[\\d,]*(?:\\.\\d+)?))?',
    'i'
  );

  var CURRENCY = {
    'US$': 'USD', usd: 'USD',
    'C$': 'CAD', 'CA$': 'CAD', cad: 'CAD',
    'A$': 'AUD', 'AU$': 'AUD', aud: 'AUD',
    'HK$': 'HKD', hkd: 'HKD',
    'S$': 'SGD', sgd: 'SGD',
    'NT$': 'TWD', twd: 'TWD',
    'CN¥': 'CNY', rmb: 'CNY', cny: 'CNY', '¥': 'CNY',
    'JP¥': 'JPY',
    '€': 'EUR', eur: 'EUR',
    '£': 'GBP', gbp: 'GBP',
    '₹': 'INR', inr: 'INR',
    '₩': 'KRW', krw: 'KRW',
    pkr: 'PKR', sar: 'SAR', aed: 'AED', try: 'TRY', brl: 'BRL',
    // A bare "$" is genuinely ambiguous on a site that serves US$, HK$ and A$
    // from the same page, so it is reported as unknown rather than guessed.
    $: '',
  };

  /** Parse the first money token in a string. Returns null when there is none. */
  function parseMoney(s) {
    var m = String(s || '').match(MONEY_RE);
    if (!m) return null;
    var from = num(m[2]);
    if (from === null) return null;
    var to = m[3] ? num(m[3]) : null;
    if (to !== null && to < from) to = null;
    return {
      symbol: m[1],
      // Fall back to USD for a bare "$" so the row is still comparable; the
      // symbol is kept on the record so the display can show "US$" honestly.
      currency: m[1] in CURRENCY ? CURRENCY[m[1]] || 'USD' : String(m[1]).toUpperCase(),
      from: from,
      to: to,
    };
  }

  // ------------------------------------------------------------- country
  var COUNTRY_NAMES =
    'China|India|Pakistan|Turkey|Türkiye|Bangladesh|Vietnam|Indonesia|Thailand|Malaysia|' +
    'Italy|Germany|Spain|France|Brazil|Mexico|Russia|Ukraine|Korea|South Korea|Japan|Egypt|' +
    'Morocco|Nigeria|Kenya|Ethiopia|Saudi|UAE|U.A.E.|Qatar|Kuwait|Oman|Bahrain|Jordan|' +
    'Lebanon|Iran|Singapore|USA|United States|United Kingdom|Netherlands|Poland|Portugal|' +
    'Taiwan|Hong Kong|Colombia|Peru|Chile|Argentina|Israel|Canada|Australia';
  var COUNTRY_CODES =
    'BD|TH|TN|TR|PK|IN|GB|DE|FR|US|IT|ES|BR|MX|RU|UA|KR|JP|EG|MA|NG|KE|ET|SA|AE|QA|KW|OM|BH|' +
    'JO|LB|IQ|IR|SG|AU|NZ|CA|PL|CZ|RO|PT|SE|NO|DK|NL|BE|AT|CH|GR|TW|HK|CN';
  // The trailing guard is the whole point: "US$5,000" contains a bare "US" that
  // would otherwise be read as the United States.
  var CODE_RE = new RegExp('\\b(' + COUNTRY_CODES + ')\\b(?![\\d$€£¥₹₩A-Za-z])');
  var NAME_RE = new RegExp('\\b(' + COUNTRY_NAMES + ')\\b', 'i');

  function findCountry(s) {
    var t = String(s || '');
    var named = t.match(NAME_RE);
    if (named) return named[1];
    var coded = t.match(CODE_RE);
    return coded ? coded[1] : '';
  }

  // ------------------------------------------------------- shared metrics
  // These labels are the same on both page shapes, so they are parsed once.
  function parseMetrics(body) {
    var onTime = grab(body, /on-?time\s*delivery\s*:?\s*([\d]{1,3})\s*%/i);
    var reorder = grab(body, /reorder\s*rate\s*:?\s*([\d]{1,3})\s*%/i);
    // "<1h" keeps its operator: answering inside an hour is a different promise
    // from answering in exactly an hour, and a buyer comparing rows needs to see
    // which one was promised.
    var rm = String(body || '').match(/response\s*time\s*:?\s*((?:<|≤)\s*)?(\d+\s*[hms]?\s*(?:in)?)/i);
    var response = rm ? clean(rm[1] || '') + clean(rm[2]) : '';
    // Online revenue is a range such as "$50K - $100K". Stop at the label that
    // follows it rather than swallowing it.
    var revenue = grab(
      body,
      /online\s*revenue\s*:?\s*(\$?\s?[\d.,]+\s*[KM]?\s*(?:[-–—]\s*\$?\s?[\d.,]+\s*[KM]?)?)/i
    );
    return {
      onTimeDelivery: onTime !== null ? Number(onTime) : null,
      reorderRate: reorder !== null ? Number(reorder) : null,
      responseRate: response ? clean(response) : '',
      onlineRevenue: revenue ? clean(revenue) : '',
    };
  }

  function parseMoq(body) {
    var qty = grab(body, /min\.?\s*order[^0-9]{0,24}([\d][\d,]*)/i);
    var unit = grab(body, /min\.?\s*order[^0-9]{0,24}[\d][\d,]*\s*([a-zA-Z]{2,14})/i);
    return { moqQty: qty !== null ? num(qty) : null, moqUnit: unit ? clean(unit).toLowerCase() : '' };
  }

  // ============================================================ SUPPLIERS TAB
  // One card per company. The card owns a header (name, flag, badges) and a
  // strip of product tiles, each with its own price.
  var PRODUCT_SEL = 'a[href*="/product-detail/"], a[href*="showproduct.html"]';
  var COMPANY_SEL =
    'a[href*="/company/"], a[href*="company-detail"], a[href*="/showcompany"], ' +
    'a[href*="/supplier/"], a[href*="/company-profile"]';

  function productLinksWithin(root) {
    return Array.prototype.slice.call(root.querySelectorAll(PRODUCT_SEL)).filter(isVisible);
  }

  /** The smallest ancestor that owns this company's products: one card, one row. */
  function supplierCardFor(companyLink, claimed) {
    var node = companyLink;
    for (var i = 0; i < 10 && node && node !== document.body; i++) {
      node = node.parentElement;
      if (!node) return null;
      if (claimed.indexOf(node) !== -1) return null;
      if (node.querySelectorAll(COMPANY_SEL).length > 2) return null; // hit the list
      var t = text(node);
      if (!t || t.length > 9000) continue;
      if (productLinksWithin(node).length > 0) return node;
    }
    return null;
  }

  /** Fallback when the company name is not a link: find the card by its metrics. */
  function supplierCardsFromProductLinks() {
    var links = Array.prototype.slice.call(document.querySelectorAll(PRODUCT_SEL)).filter(isVisible);
    var claimed = [];
    var cards = [];
    for (var i = 0; i < links.length; i++) {
      var node = links[i];
      for (var up = 0; up < 10 && node && node !== document.body; up++) {
        node = node.parentElement;
        if (!node) break;
        if (claimed.indexOf(node) !== -1) break;
        var t = text(node);
        if (t && t.length > 9000) break;
        var hints = 0;
        if (/on-?time\s*delivery/i.test(t)) hints++;
        if (/reorder\s*rate/i.test(t)) hints++;
        if (/response\s*time/i.test(t)) hints++;
        if (/online\s*revenue/i.test(t)) hints++;
        if (/\b\d{1,2}\s*\+?\s*(?:yr|yrs|year|years)\b/i.test(t)) hints++;
        if (/min\.?\s*order/i.test(t)) hints++;
        if (NAME_RE.test(t) || CODE_RE.test(t)) hints++;
        var products = node.querySelectorAll(PRODUCT_SEL).length;
        if (hints >= 2 && products >= 1) {
          claimed.push(node);
          cards.push({ card: node, companyLink: null, link: links[i] });
          break;
        }
      }
    }
    return cards;
  }

  function collectSupplierCards() {
    var claimed = [];
    var cards = [];
    var companyLinks = Array.prototype.slice.call(document.querySelectorAll(COMPANY_SEL))
      .filter(function (el) {
        return isVisible(el) && text(el).length > 1 && text(el).length < 120;
      });

    for (var i = 0; i < companyLinks.length; i++) {
      var card = supplierCardFor(companyLinks[i], claimed);
      if (!card) continue;
      claimed.push(card);
      cards.push({ card: card, companyLink: companyLinks[i], link: productLinksWithin(card)[0] || null });
    }

    if (cards.length < 3) cards = cards.concat(supplierCardsFromProductLinks());
    return cards;
  }

  /**
   * The company name, cleaned of the badges that sit next to it.
   * "Zhuji Yuanheng Sewing Equipment Co., Ltd.  Zhejiang. CN  1yr  Verified"
   * must come back as the company only, not the whole header line.
   */
  function cleanCompanyName(s) {
    var out = clean(s);
// Trailing flag code / province / badges, in the order Alibaba renders them.
    // Every alternation must be wrapped: an ungrouped "A|B" turns the leading
    // "\s+" into one optional alternative among many, which silently eats the
    // last letters of any company whose name ends in a two-letter code
    // (SOURCING -> SOURCG).
    out = out.replace(/\s+/g, ' ');
    out = out.replace(new RegExp('\\s+(?:' + COUNTRY_NAMES + ')\\b.*$', 'i'), '');
    out = out.replace(new RegExp('\\s+(?:' + COUNTRY_CODES + ')\\b(?![\\d$€£¥₹₩A-Za-z]).*$'), '');
    out = out.replace(/\s+(?:\d{1,2}\s*\+?\s*(?:yr|yrs|year|years)|verified|gold|assessed|trade\s*assurance|supplier)\b.*$/i, '');
    out = clean(out).replace(/[,\s]+$/, '');
    // A company name legitimately ends in an abbreviation's full stop
    // ("Co., Ltd."), so only drop a trailing dot when it is not one.
    if (!/\b(?:Ltd|Inc|Co|LLC|GmbH|BV|PLC|S\.A)\.$/i.test(out)) out = out.replace(/\.$/, '');
    return out;
  }

  /** Company name from the card header when the name is not a link. */
  function companyNameFromHeader(body) {
    var ls = lines(body);
    for (var i = 0; i < Math.min(ls.length, 4); i++) {
      var line = ls[i];
      if (!line || line.length < 3 || line.length > 80) continue;
      if (/min\.?\s*order|response|revenue|on-?time|reorder|verified|yrs?\b|pieces|units|sets|matches/i.test(line)) continue;
      if (/^[\d.,%$€£¥₹\-+ ]+$/.test(line)) continue;
      if (parseMoney(line)) continue;
      var name = cleanCompanyName(line);
      if (name.length >= 3) return name;
    }
    return '';
  }

  /**
   * The tile that owns one product link: the smallest ancestor that holds this
   * link alone and carries a price. Pairing prices to products by position in
   * the card is the fallback for flat layouts.
   */
  function tileFor(link, card) {
    var node = link;
    for (var i = 0; i < 6 && node && node !== card; i++) {
      node = node.parentElement;
      if (!node) return null;
      if (node.querySelectorAll(PRODUCT_SEL).length > 1) return null;
      var t = text(node);
      if (!t) continue;
      if (t.length > 400) return null;
      if (MONEY_RE.test(t)) return node;
    }
    return null;
  }

  function parseSupplierCard(entry) {
    var card = entry.card;
    var body = text(card);
    var headLines = lines(body).slice(0, 6).join(' | ');
    var products = productLinksWithin(card);

    // ---- product tiles: what this supplier actually sells, and for how much.
    // Prices and titles both appear as their own lines and Alibaba renders the
    // tiles left to right. Reading labels and structure rather than class names
    // is what survives a redesign — the class names churn, the labels do not.
    var offers = [];
    var seenOffer = {};
    function addOffer(title, money, url) {
      if (!money || offers.length >= 6) return;
      var key = money.currency + '|' + money.from + '|' + (money.to || '');
      if (seenOffer[key]) return;
      seenOffer[key] = true;
      offers.push({
        title: title || '',
        from: money.from,
        to: money.to,
        currency: money.currency,
        url: url || '',
      });
    }
    function linkTitle(l) {
      return clean(l.getAttribute('title') || l.getAttribute('aria-label') || text(l));
    }

    for (var p = 0; p < products.length; p++) {
      var tile = tileFor(products[p], card);
      if (!tile) continue;
      addOffer(linkTitle(products[p]), parseMoney(text(tile)), products[p].href.split('?')[0]);
    }

    if (offers.length === 0) {
      // Flat layout: pair the card's price lines with the product links in DOM
      // order. The "min. order" line is a price-tier box, not an offer.
      var ls = lines(body);
      var priceLines = [];
      for (var i = 0; i < ls.length; i++) {
        if (/min\.?\s*order/i.test(ls[i])) continue;
        var money = parseMoney(ls[i]);
        if (money) priceLines.push(money);
      }
      for (var k = 0; k < priceLines.length; k++) {
        var lk = products[k];
        addOffer(lk ? linkTitle(lk) : '', priceLines[k], lk ? lk.href.split('?')[0] : '');
      }
    }

    // Cheapest published offer becomes the headline price for the comparison.
    var best = null;
    for (var o = 0; o < offers.length; o++) {
      if (!best || offers[o].from < best.from) best = offers[o];
    }

    var companyName = entry.companyLink
      ? cleanCompanyName(text(entry.companyLink))
      : companyNameFromHeader(body);
    if (!companyName && products.length) companyName = linkTitle(products[0]).slice(0, 60);

    var headerCountry = findCountry(headLines);
    var metrics = parseMetrics(body);
    var moq = parseMoq(body);
    var years = grab(body, /(\d{1,2})\s*\+?\s*(?:yr|yrs|year|years)\b/i);

    var record = {
      productId: '',
      sourceUrl: best && best.url ? best.url : '',
      title: best && best.title ? best.title : (offers[0] ? offers[0].title : companyName),
      companyName: companyName,
      companyUrl: entry.companyLink ? entry.companyLink.href.split('?')[0] : '',
      country: headerCountry || findCountry(body),
      yearsOnPlatform: years !== null ? Number(years) : null,
      verifiedSupplier: /(?:^|[\s|])(verified|gold\s*supplier|assessed\s*supplier)(?:$|[\s|])/i.test(headLines),
      tradeAssurance: /trade\s*assurance/i.test(body),
      businessType: /factory|manufacturer|production\s*base|\bft\b/i.test(body) ? 'Manufacturer' : '',
      moqQty: moq.moqQty,
      moqUnit: moq.moqUnit,
      onTimeDelivery: metrics.onTimeDelivery,
      reorderRate: metrics.reorderRate,
      responseRate: metrics.responseRate,
      onlineRevenue: metrics.onlineRevenue,
      leadTime: '',
      currency: best ? best.currency : '',
      priceTiers: best ? [{ minQty: 1, maxQty: null, unitPrice: best.from }] : [],
      priceTo: best ? best.to : null,
      products: offers,
      raw: body.slice(0, 400),
    };
    if (!record.currency) {
      var anyMoney = parseMoney(body);
      record.currency = anyMoney ? anyMoney.currency : '';
    }
    if (!record.productId) record.productId = (companyName + '|' + record.title).slice(0, 80);
    return record;
  }

  // ============================================================== PRODUCTS TAB
  // One card per offer. The card is the row, and its price-tier box is a
  // legitimate price source here — which is exactly why the supplier path
  // above had to stop reading it as a company name.
  var OFFER_HINT = /(min\.?\s*order|yrs?|years|verified|response\s*time|on-?time|reorder|revenue)/i;

  function offerCardFor(link) {
    var node = link;
    for (var i = 0; i < 8 && node && node !== document.body; i++) {
      node = node.parentElement;
      if (!node) return null;
      var t = text(node);
      if (t && OFFER_HINT.test(t) && t.length < 1500) return node;
    }
    return null;
  }

  function parseOfferCard(entry) {
    var card = entry.card;
    var body = text(card);
    var productHref = entry.link ? entry.link.href : '';
    var productTitle = clean(
      entry.link.getAttribute('title') || entry.link.getAttribute('aria-label') || text(entry.link)
    );

    var name = '';
    var heading = card.querySelector('h1, h2, h3, h4, [class*="title" i], [class*="name" i]');
    if (heading) {
      var ht = text(heading);
      if (ht && ht.length < 90 && !/min\.?\s*order|\b\d+\s*yrs?\b/i.test(ht)) name = ht;
    }
    if (!name) name = companyNameFromHeader(body);
    if (!name) name = productTitle.slice(0, 60);

    var headLines = lines(body).slice(0, 6).join(' | ');
    var years = grab(body, /(\d{1,2})\s*\+?\s*(?:yr|yrs|year|years)\b/i);
    var metrics = parseMetrics(body);
    var moq = parseMoq(body);
    var money = parseMoney(body);
    var idMatch = (productHref || '').match(/_(\d{6,})\.html/);

    return {
      productId: (idMatch ? idMatch[1] : '') || (name + '|' + productTitle).slice(0, 80),
      sourceUrl: productHref ? productHref.split('?')[0] : '',
      title: productTitle,
      companyName: cleanCompanyName(name),
      country: findCountry(headLines) || findCountry(body),
      yearsOnPlatform: years !== null ? Number(years) : null,
      verifiedSupplier: /(?:^|[\s|])(verified|gold\s*supplier|assessed\s*supplier)(?:$|[\s|])/i.test(headLines),
      tradeAssurance: /trade\s*assurance/i.test(body),
      businessType: /factory|manufacturer|\bft\b/i.test(body) ? 'Manufacturer' : '',
      moqQty: moq.moqQty,
      moqUnit: moq.moqUnit,
      onTimeDelivery: metrics.onTimeDelivery,
      reorderRate: metrics.reorderRate,
      responseRate: metrics.responseRate,
      onlineRevenue: metrics.onlineRevenue,
      leadTime: '',
      currency: money ? money.currency : '',
      priceTiers: money ? [{ minQty: 1, maxQty: null, unitPrice: money.from }] : [],
      priceTo: money ? money.to : null,
      products: money
        ? [{ title: productTitle, from: money.from, to: money.to, currency: money.currency, url: productHref.split('?')[0] }]
        : [],
      raw: body.slice(0, 400),
    };
  }

  // ------------------------------------------------------------------- run
  var u = String(location.href);
  var scene = 'products';
  if (/SearchScene=suppliers/i.test(u) || /[?&]scene=suppliers/i.test(u)) scene = 'suppliers';
  else if (/\/companies?\//i.test(location.pathname) || /company-detail/i.test(u)) scene = 'suppliers';

  var entries;
  if (scene === 'suppliers') {
    entries = collectSupplierCards().map(function (e) {
      return { card: e.card, companyLink: e.companyLink, link: e.link };
    });
  } else {
    var claimed2 = [];
    var seen2 = [];
    var links2 = Array.prototype.slice.call(document.querySelectorAll(PRODUCT_SEL)).filter(isVisible);
    entries = [];
    for (var i2 = 0; i2 < links2.length; i2++) {
      var card2 = offerCardFor(links2[i2]);
      if (!card2 || seen2.indexOf(card2) !== -1) continue;
      seen2.push(card2);
      claimed2.push(card2);
      entries.push({ card: card2, companyLink: null, link: links2[i2] });
    }
  }

  var records = [];
  for (var c = 0; c < entries.length; c++) {
    var rec = scene === 'suppliers'
      ? parseSupplierCard(entries[c])
      : parseOfferCard(entries[c]);
    if (rec && (rec.companyName || rec.title)) records.push(rec);
  }

  // Collapse duplicate suppliers that appear on the same page.
  var seenKeys = {};
  var unique = [];
  for (var r = 0; r < records.length; r++) {
    var k = (records[r].companyName || '') + '|' + (records[r].sourceUrl || '');
    if (seenKeys[k]) continue;
    seenKeys[k] = true;
    unique.push(records[r]);
  }

  return {
    ok: unique.length > 0,
    page: 'search',
    scene: scene,
    url: location.href,
    title: document.title,
    count: unique.length,
    candidates: unique,
    pricedCount: unique.filter(function (x) {
      return Array.isArray(x.priceTiers) && x.priceTiers.length > 0;
    }).length,
    bodySample: (document.body ? document.body.innerText : '').slice(0, 3000),
  };
}