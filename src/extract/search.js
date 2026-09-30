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
    // Revenue is a range ("$1M - $2M") or an open bound ("<1k"). The leading
    // comparator is part of the published fact and must survive.
    var revenue = grab(
      body,
      /online\s*revenue\s*:?\s*([<>≤≥]?\s*\$?\s?[\d.,]+\s*[KM]?\s*(?:[-–—]\s*\$?\s?[\d.,]+\s*[KM]?)?)/i
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
  // One card per COMPANY. Every selector below is a data attribute or an alt
  // text, never a class name: Alibaba's classes are hashed per deploy
  // (CawI5, TMl6f, f3wvg) and change without warning, while these do not.
  //
  //   [data-supplier-card="true"]              the card
  //   data-dot-params                            JSON: companyId, isFactory, ...
  //   span[title]                                the company name
  //   img[alt="countryFlag"] + next sibling      the country code ("PK")
  //   [data-supplier-card-gold-years]            "2 yrs"
  //   [data-supplier-card-reviews]               "(52 reviews)"
  //   a[data-supplier-card-product]              one of the supplier's products
  //
  // Everything is still read from visible text as well, so a card that renders
  // differently yields whatever it does publish rather than nothing at all.

  var CARD_SEL = '[data-supplier-card="true"]';
  var TILE_SEL = 'a[data-supplier-card-product], [data-supplier-card-product]';
  var PRODUCT_SEL = 'a[href*="/product-detail/"], a[href*="showproduct.html"]';

  function all(root, sel) {
    try {
      return Array.prototype.slice.call(root.querySelectorAll(sel));
    } catch (e) {
      return [];
    }
  }

  /** JSON in an attribute, decoded. Never throws: a card must still parse. */
  function params(el) {
    try {
      return JSON.parse(el.getAttribute('data-dot-params') || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  /** True when the element sits inside one of the card's product tiles. */
  function inProductTile(el, card) {
    var node = el;
    for (var i = 0; i < 6 && node && node !== card; i++) {
      if (node.getAttribute && node.getAttribute('data-supplier-card-product') !== null) return true;
      node = node.parentElement;
    }
    return false;
  }

  /**
   * The company name is the first titled element that is not a product tile.
   * Alibaba renders it as <span title="al jannat caps">, and the product tiles
   * below carry no title of their own, so document order alone is enough.
   */
  function nameFromHeader(card) {
    var titled = all(card, '[title]');
    for (var i = 0; i < titled.length; i++) {
      var el = titled[i];
      if (inProductTile(el, card)) continue;
      var t = clean(el.getAttribute('title') || text(el));
      if (t.length < 3 || t.length > 90) continue;
      if (/(min\.?\s*order|response|revenue|on-?time|reorder|verified|\b\d{1,2}\s*(?:\+?\s*)?(?:yr|yrs|year|years)\b|pieces|units|sets|review|requirements|rating)/i.test(t)) continue;
      return t;
    }
    return '';
  }

  /**
   * Country and province, read off the flag: the element before it is the
   * province ("Sindh,") and the element after it is the code ("PK"). Guessing
   * from the card text instead would keep tripping over "US" inside "US$".
   */
  function countryFromCard(card, headerText, body) {
    var flag = all(card, 'img[alt="countryFlag"]')[0];
    if (flag) {
      var code = clean(text(flag.nextElementSibling));
      var province = clean(text(flag.previousElementSibling)).replace(/,$/, '');
      if (/^[A-Za-z]{2,3}$/.test(code)) {
        return { country: code.toUpperCase(), province: province || '' };
      }
    }
    return { country: findCountry(headerText) || findCountry(body), province: '' };
  }

  function yearsFromCard(card, body) {
    var el = all(card, '[data-supplier-card-gold-years]')[0];
    var from = grab(text(el), /(\d{1,2})\s*\+?\s*(?:yr|yrs|year|years)\b/i);
    if (from === null) from = grab(body, /(\d{1,2})\s*\+?\s*(?:yr|yrs|year|years)\b/i);
    return from === null ? null : Number(from);
  }

  function ratingFromCard(card, headerText, body) {
    var m = String(headerText).match(/(\d(?:\.\d)?)\s*\/\s*5/) ||
      String(body).match(/(\d(?:\.\d)?)\s*\/\s*5/);
    return m ? Number(m[1]) : null;
  }

  function reviewsFromCard(card, body) {
    var el = all(card, '[data-supplier-card-reviews]')[0];
    var src = text(el) || String(body);
    var m = String(src).match(/([\d][\d,.]*)\s*(?:reviews?|ratings?)/i);
    if (!m) return null;
    var n = num(m[1]);
    return n === null ? null : Math.round(n);
  }

  /**
   * "Main products" is a labelled bullet list of what the factory actually
   * makes. It is the most useful free text on the card, and unlike the product
   * tile it carries real names rather than a URL slug.
   */
  function mainProductsFrom(card) {
    var out = [];
    var label = null;
    var candidates = all(card, 'div, span, p, h1, h2, h3, h4');
    for (var i = 0; i < candidates.length; i++) {
      if (/^main\s*products?$/i.test(text(candidates[i]))) {
        label = candidates[i];
        break;
      }
    }
    var host = label && label.parentElement ? label.parentElement : card;
    var titled = all(host, '[title]');
    for (var j = 0; j < titled.length && out.length < 5; j++) {
      var el = titled[j];
      if (inProductTile(el, card)) continue;
      var t = clean(el.getAttribute('title') || text(el));
      if (t.length < 2 || t.length > 60) continue;
      if (out.indexOf(t) === -1) out.push(t);
    }
    return out;
  }

  /**
   * Alibaba's product URLs carry a readable slug:
   *   /product-detail/Premium-Quality-Factory-Made-Round-Fashion_10000037271758.html
   * That slug is a lowercased product title, which beats showing a bare id when
   * the card offers no title text at all.
   */
  function titleFromProductUrl(href) {
    var m = String(href || '').match(/\/product-detail\/([^_?]+)_\d+\.html/i);
    if (!m) return '';
    var words = decodeURIComponent(m[1]).replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
    return words.length > 1 ? words : '';
  }

  function collectSupplierCards() {
    var cards = all(document, CARD_SEL).filter(function (el) {
      return isVisible(el);
    });
    if (cards.length > 0) return cards;
    // Older layout: no data attribute, so fall back to label-based detection.
    return supplierCardsFromProductLinks().map(function (e) { return e.card; });
  }

  /** Fallback: find a supplier card by the labels it prints, not by markup. */
  function supplierCardsFromProductLinks() {
    var links = all(document, PRODUCT_SEL).filter(isVisible);
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
        var products = all(node, PRODUCT_SEL).length;
        if (hints >= 2 && products >= 1) {
          claimed.push(node);
          cards.push({ card: node, link: links[i] });
          break;
        }
      }
    }
    return cards;
  }

  /**
   * Strip the badges that sit next to a company name.
   * "Zhuji Yuanheng Sewing Equipment Co., Ltd.  Zhejiang. CN  1yr  Verified"
   * must come back as the company only.
   *
   * Every alternation must be wrapped: an ungrouped "A|B" turns the leading
   * "\s+" into one optional alternative among many, which silently eats the
   * last letters of any company whose name ends in a two-letter code
   * (SOURCING -> SOURCG).
   */
  function cleanCompanyName(s) {
    var out = clean(s).replace(/\s+/g, ' ');
    out = out.replace(new RegExp('\\s+(?:' + COUNTRY_NAMES + ')\\b.*$', 'i'), '');
    out = out.replace(new RegExp('\\s+(?:' + COUNTRY_CODES + ')\\b(?![\\d$€£¥₹₩A-Za-z]).*$'), '');
    out = out.replace(/\s+(?:\d{1,2}\s*\+?\s*(?:yr|yrs|year|years)|verified|gold|assessed|trade\s*assurance|supplier)\b.*$/i, '');
    out = clean(out).replace(/[,\s]+$/, '');
    // A company name legitimately ends in an abbreviation's full stop
    // ("Co., Ltd."), so only drop a trailing dot when it is not one.
    if (!/\b(?:Ltd|Inc|Co|LLC|GmbH|BV|PLC|S\.A)\.$/i.test(out)) out = out.replace(/\.$/, '');
    return out;
  }

  /** Last-resort name: the first card line that is not a label or a price. */
  function companyNameFromHeader(body) {
    var ls = lines(body);
    for (var i = 0; i < Math.min(ls.length, 6); i++) {
      var line = ls[i];
      if (!line || line.length < 3 || line.length > 80) continue;
      if (/min\.?\s*order|response|revenue|on-?time|reorder|verified|\b\d{1,2}\s*\+?\s*(?:yr|yrs|year|years)\b|pieces|units|sets|matches|review|\/5|main\s*products?/i.test(line)) continue;
      if (/^[\d.,%$€£¥₹\-+ ]+$/.test(line)) continue;
      if (parseMoney(line)) continue;
      var name = cleanCompanyName(line);
      if (name.length >= 3) return name;
    }
    return '';
  }

  function parseSupplierCard(card) {
    var body = text(card);
    var p = params(card);
    var header = all(card, 'span[title], div[title], h1, h2, h3, h4')
      .filter(function (el) { return !inProductTile(el, card); })
      .slice(0, 6)
      .map(function (el) { return text(el); })
      .join(' | ');
    // The header block is the first few lines of the card: name, province,
    // country, rating, reviews, years, and the action buttons.
    var headerLines = lines(body).slice(0, 8).join(' | ');

    // The name reader needs the card text with its line breaks intact: the
    // joined header is one long line, so every candidate line would fail the
    // "is this a label?" filter and the name would come back empty.
    var name = nameFromHeader(card) || companyNameFromHeader(body);
    var where = countryFromCard(card, headerLines, body);
    var metrics = parseMetrics(body);
    var moq = parseMoq(body);

    // ---- the supplier's own products, each with its own price and MOQ
    var offers = [];
    var seenOffer = {};
    function addOffer(offer) {
      if (!offer || offers.length >= 6) return;
      var key = offer.currency + '|' + offer.from + '|' + (offer.to || '');
      if (seenOffer[key]) return;
      seenOffer[key] = true;
      offers.push(offer);
    }

    var tiles = all(card, TILE_SEL).filter(isVisible);
    for (var t = 0; t < tiles.length; t++) {
      var tileText = text(tiles[t]);
      // "US$4.20-5.10  Min. order: 10 pieces" — the price and the minimum are
      // two separate facts printed in the same tile, so read them apart.
      var linesInTile = lines(tileText);
      var money = null;
      for (var l = 0; l < linesInTile.length; l++) {
        if (/min\.?\s*order/i.test(linesInTile[l])) continue;
        money = parseMoney(linesInTile[l]);
        if (money) break;
      }
      if (!money) continue;
      var href = tiles[t].href || tiles[t].getAttribute('href') || '';
      var tileMoq = parseMoq(tileText);
      addOffer({
        title: titleFromProductUrl(href),
        from: money.from,
        to: money.to,
        currency: money.currency,
        url: href.split('?')[0],
        moqQty: tileMoq.moqQty,
        moqUnit: tileMoq.moqUnit,
      });
    }

    // Older layout: no product-tile markers at all. Fall back to the card's own
    // price lines, paired with its product links in the order they are printed.
    if (offers.length === 0) {
      var priceLines = [];
      var cardLines = lines(body);
      for (var pi = 0; pi < cardLines.length; pi++) {
        if (/min\.?\s*order/i.test(cardLines[pi])) continue;
        var mm = parseMoney(cardLines[pi]);
        if (mm) priceLines.push(mm);
      }
      var linksInCard = all(card, PRODUCT_SEL).filter(isVisible);
      for (var qi = 0; qi < priceLines.length; qi++) {
        var lk = linksInCard[qi];
        var href2 = lk ? String(lk.href || lk.getAttribute('href') || '').split('?')[0] : '';
        var label = lk ? clean(lk.getAttribute('title') || '') : '';
        // A link whose text is the price itself (an image-only tile) gives us no
        // title, so fall back to the slug in its URL.
        if (!label || parseMoney(label)) label = titleFromProductUrl(href2);
        addOffer({
          title: label,
          from: priceLines[qi].from,
          to: priceLines[qi].to,
          currency: priceLines[qi].currency,
          url: href2,
          moqQty: moq.moqQty,
          moqUnit: moq.moqUnit,
        });
      }
    }

    var best = null;
    for (var o = 0; o < offers.length; o++) {
      if (!best || offers[o].from < best.from) best = offers[o];
    }

    // The company itself is the row, so the headline product is the cheapest
    // thing it sells and the MOQ that goes with it is the one that matters.
    var record = {
      productId: p.companyId ? 'co' + p.companyId : '',
      title: best && best.title ? best.title : (mainProductsFrom(card)[0] || name),
      sourceUrl: best && best.url ? best.url : '',
      companyName: cleanCompanyName(name),
      companyUrl: '',
      country: where.country,
      province: where.province,
      rating: ratingFromCard(card, headerLines, body),
      reviewCount: reviewsFromCard(card, body),
      mainProducts: mainProductsFrom(card),
      yearsOnPlatform: yearsFromCard(card, body),
      verifiedSupplier: /(verified|assured)\s*supplier|\bverified\b/i.test(header),
      tradeAssurance: /trade\s*assurance/i.test(body),
      // isFactory is Alibaba's own flag, which is better evidence than a
      // keyword search over the card text.
      // Alibaba's own isFactory flag is the best evidence; a company whose own
      // name says "Factory" is a factory even when the flag is not set; and a
      // trading company is named as one.
      businessType: p.isFactory === true ||
        /custom\s*manufacturer|verified\s*custom\s*manufacturer/i.test(body) ||
        /\b(factory|manufactur\w*|producing|weaver|textile|garment\w*|knit\w*)\b/i.test(name)
        ? 'Manufacturer'
        : (/trading\s*co|general\s*partnership|\bco\.?\s*,?\s*ltd\b|limited/i.test(name)
            ? 'Trading Company' : ''),
      moqQty: best && best.moqQty !== null ? best.moqQty : moq.moqQty,
      moqUnit: best && best.moqUnit ? best.moqUnit : moq.moqUnit,
      onTimeDelivery: metrics.onTimeDelivery,
      reorderRate: metrics.reorderRate,
      responseRate: metrics.responseRate,
      onlineRevenue: metrics.onlineRevenue,
      leadTime: '',
      currency: best ? best.currency : (parseMoney(body) || { currency: '' }).currency,
      priceTiers: best ? [{ minQty: 1, maxQty: null, unitPrice: best.from }] : [],
      priceTo: best ? best.to : null,
      products: offers,
      raw: body.slice(0, 400),
    };
    if (!record.productId) record.productId = (record.companyName + '|' + record.title).slice(0, 80);
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

  var records = [];
  var supplierCards = [];
  if (scene === 'suppliers') {
    supplierCards = collectSupplierCards();
    var byId = {};
    for (var s = 0; s < supplierCards.length; s++) {
      var sup = parseSupplierCard(supplierCards[s]);
      if (!sup || !sup.companyName) continue;
      // The same company can appear twice on one page (two company ids, or a
      // card rendered twice by the virtual list). Key on the company id.
      var key = sup.productId || sup.companyName;
      if (byId[key]) continue;
      byId[key] = true;
      records.push(sup);
    }
  } else {
    var claimed2 = [];
    var links2 = all(document, PRODUCT_SEL).filter(isVisible);
    for (var i2 = 0; i2 < links2.length; i2++) {
      var card2 = offerCardFor(links2[i2]);
      if (!card2 || claimed2.indexOf(card2) !== -1) continue;
      claimed2.push(card2);
      var rec = parseOfferCard({ card: card2, link: links2[i2] });
      if (rec && (rec.companyName || rec.title)) records.push(rec);
    }
  }

  // One company can own several cards on the page; keep the cheapest offer.
  var seenKeys = {};
  var unique = [];
  for (var r = 0; r < records.length; r++) {
    var k = (records[r].companyName || '') + '|' + (records[r].sourceUrl || '');
    if (seenKeys[k]) continue;
    seenKeys[k] = true;
    unique.push(records[r]);
  }

  // ------------------------------------------------------------- evidence
  // When Alibaba changes this page, the fix needs the real markup, not a
  // screenshot and not a guess. Two cards' outerHTML plus the anchors that
  // matched is everything a repair needs, in one paste.
  function trimHtml(el, max) {
    var html = '';
    try {
      html = el.outerHTML || '';
    } catch (e) {
      return '(unreadable)';
    }
    return html.length > max ? html.slice(0, max) + '\n…[truncated]' : html;
  }

  var cardSamples = [];
  for (var cs = 0; cs < Math.min(supplierCards.length, 2); cs++) {
    cardSamples.push(trimHtml(supplierCards[cs], 4000));
  }

  return {
    ok: unique.length > 0,
    page: 'search',
    scene: scene,
    url: location.href,
    title: document.title,
    count: unique.length,
    // Which signal found the cards: the stable data attribute, or the label
    // fallback. If this flips to "labels", Alibaba dropped the attributes and
    // the extractor is living on borrowed time.
    strategy: all(document, CARD_SEL).length > 0 ? 'data-supplier-card' : 'label-fallback',
    anchors: {
      card: all(document, CARD_SEL).length,
      productTile: all(document, TILE_SEL).length,
      countryFlag: all(document, 'img[alt="countryFlag"]').length,
      goldYears: all(document, '[data-supplier-card-gold-years]').length,
      reviews: all(document, '[data-supplier-card-reviews]').length,
      companyTitle: all(document, 'span[title]').length,
    },
    cardSamples: cardSamples,
    candidates: unique,
    pricedCount: unique.filter(function (x) {
      return Array.isArray(x.priceTiers) && x.priceTiers.length > 0;
    }).length,
    bodySample: (document.body ? document.body.innerText : '').slice(0, 3000),
  };
}