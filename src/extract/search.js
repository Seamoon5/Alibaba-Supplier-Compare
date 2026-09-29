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
 * Strategy: anchor on the product links that every result card contains, then
 * walk up to the card that owns the link. This is resilient to class-name
 * churn in a way that a fixed selector list is not, and it degrades to label
 * scanning for every field, so a card that renders differently still yields
 * whatever text it does expose.
 */

export function harvestSearchPage() {
  // ------------------------------------------------------------------ utils
  // Collapse runs of spaces and tabs but KEEP newlines. Alibaba cards separate
  // every field with a line break, and flattening them to spaces merges
  // neighbouring labels into each other ("$50K - $100K Min. order: ...").
  var clean = function (s) {
    return s
      ? String(s).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim()
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

  // ------------------------------------------------------------- card shape
  // Walk up from a product link to the smallest ancestor that behaves like a
  // result card: it must carry a "Min. order" label or a set of supplier
  // metric labels. Bounded to 8 levels so we never grab the whole page.
  var CARD_HINT = /(min\.?\s*order|yrs?|years|verified|response\s*time|on-?time|reorder|revenue)/i;

  function cardFor(link) {
    var node = link;
    for (var i = 0; i < 8 && node; i++) {
      node = node.parentElement;
      if (!node || node === document.body) break;
      var t = text(node);
      if (t && CARD_HINT.test(t) && t.length < 1500) return node;
    }
    return null;
  }

  var links = Array.prototype.slice.call(
    document.querySelectorAll('a[href*="/product-detail/"], a[href*="showproduct.html"]')
  );

  var cards = [];
  var seen = [];
  for (var i = 0; i < links.length; i++) {
    var link = links[i];
    if (!isVisible(link)) continue;
    var card = cardFor(link);
    if (!card) continue;
    // A supplier card can hold several product links; treat it as one entry.
    if (seen.indexOf(card) !== -1) continue;
    seen.push(card);
    cards.push({ card: card, link: link });
  }

  // ----------------------------------------------------------------- parsing
  function parseCard(entry) {
    var card = entry.card;
    var body = text(card);
    var productHref = entry.link ? entry.link.href : '';
    var productTitle = clean(entry.link.getAttribute('title') || text(entry.link));

    // Company name: the first heading in the card, or the first line of card
    // text that looks like a company rather than a metric label. A heading
    // lookup is tried first because guessing from prose is unreliable.
    var name = '';
    var heading = card.querySelector('h1, h2, h3, h4, [class*="title" i], [class*="name" i]');
    if (heading) {
      var ht = text(heading);
      if (ht && ht.length < 90 && !/min\.?\s*order|\b\d+\s*yrs?\b/i.test(ht)) name = ht;
    }
    if (!name) {
      var lines = body.split('\n');
      for (var li = 0; li < lines.length && li < 6; li++) {
        var line = clean(lines[li]);
        if (!line || line.length < 3 || line.length > 60) continue;
        if (/min\.?\s*order|response|revenue|on-?time|reorder|verified|yrs?\b|pieces|units|sets/i.test(line)) continue;
        if (/^[\d.,%$Kk\-+]+$/.test(line)) continue;
        name = line;
        break;
      }
    }
    if (!name) name = productTitle.slice(0, 60);

    // Country: a full name anywhere in the card, or the two-letter code Alibaba
    // shows next to the flag. Codes are only trusted in the card header, since
    // a bare two-letter token deeper in the text is usually noise.
    var COUNTRY_NAMES = 'China|India|Pakistan|Turkey|Bangladesh|Vietnam|Indonesia|Thailand|Malaysia|Italy|Germany|Spain|France|Brazil|Mexico|Russia|Ukraine|Korea|Japan|Egypt|Morocco|Nigeria|Kenya|Ethiopia|Saudi|UAE|Qatar|Kuwait|Oman|Bahrain|Jordan|Lebanon|Iran|Singapore|USA|United States';
    var country = grab(body, new RegExp('\\b(' + COUNTRY_NAMES + ')\\b')) || '';
    if (!country) {
      var head = body.split('\n').slice(0, 3).join(' ');
      var codeMatch = head.match(/\b(BD|CN|IN|PK|TR|TH|VN|ID|MY|IT|DE|US|GB|FR|ES|BR|MX|RU|UA|KR|JP|EG|MA|NG|KE|ET|SA|AE|QA|KW|OM|BH|JO|LB|IQ|IR|SG|AU|NZ|CA|PL|CZ|RO|PT|SE|NO|DK|NL|BE|AT|CH|GR)\b/);
      if (codeMatch) country = codeMatch[1];
    }

    var years = grab(body, /(\d{1,2})\s*\+?\s*(?:yrs?|years?)\b/i);
    var verified = /verified\s*supplier|multispecialty\s*supplier|assessed\s*supplier|\bverified\b/i.test(body);
    var gold = /gold\s*supplier|assessed\s*supplier/i.test(body);

    var moqQty = grab(body, /min\.?\s*order[^0-9]{0,24}([\d][\d,]*)/i);
    var moqUnit = grab(body, /min\.?\s*order[^0-9]{0,24}[\d][\d,]*\s*([a-zA-Z]{2,14})/i);

    var onTime = grab(body, /on-?time\s*delivery\s*:?\s*([\d]{1,3})\s*%/i);
    var reorder = grab(body, /reorder\s*rate\s*:?\s*([\d]{1,3})\s*%/i);
    var response = grab(body, /response\s*time\s*:?\s*(?:<|≤)?\s*(\d+h?\s*m?(?:in)?)/i);
    // Online revenue is a range such as "$50K - $100K". Stop at the label
    // that follows it rather than swallowing it.
    var revenue = grab(body, /online\s*revenue\s*:?\s*(\$?\s?[\d.,]+\s*[KM]?\s*(?:[-–—]\s*\$?\s?[\d.,]+\s*[KM]?)?)/i);

    var factory = /factory|manufacturer|\bft\b/i.test(body);

    // Currency and a single price, when the card shows one. Currency and price
    // are captured as separate groups: indexing into the currency string would
    // yield its second letter rather than the amount.
    var moneyRe = /(USD|EUR|GBP|AUD|CAD|JPY|CNY|RMB|INR|PKR|SAR|AED|TRY|PLN)\s*([\d][\d,]*(?:\.\d+)?)\s*(?:[-–—]\s*[\d][\d,]*(?:\.\d+)?)?/i;
    var money = String(body).match(moneyRe);
    var currency = money ? money[1].toUpperCase() : '';
    if (currency === 'RMB') currency = 'CNY';
    var price = money ? num(money[2]) : null;

    var idMatch = (productHref || '').match(/_(\d{6,})\.html/);

    return {
      productId: (idMatch ? idMatch[1] : '') || (name + '|' + productTitle).slice(0, 80),
      sourceUrl: productHref ? productHref.split('?')[0] : '',
      title: productTitle,
      companyName: clean(name),
      country: country,
      yearsOnPlatform: years !== null ? Number(years) : null,
      verifiedSupplier: verified,
      tradeAssurance: /trade\s*assurance/i.test(body),
      businessType: factory ? 'Manufacturer' : '',
      moqQty: moqQty !== null ? num(moqQty) : null,
      moqUnit: moqUnit ? clean(moqUnit).toLowerCase() : '',
      onTimeDelivery: onTime !== null ? Number(onTime) : null,
      reorderRate: reorder !== null ? Number(reorder) : null,
      responseRate: response ? clean(response) : '',
      onlineRevenue: revenue ? clean(revenue) : '',
      goldSupplier: gold,
      currency: currency,
      // A results card has no tier ladder. One flat tier from the visible price
      // keeps the comparison math working instead of dropping the row entirely.
      priceTiers: price !== null ? [{ minQty: 1, maxQty: null, unitPrice: price }] : [],
      raw: body.slice(0, 400),
    };
  }

  var records = [];
  for (var c = 0; c < cards.length; c++) {
    var rec = parseCard(cards[c]);
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

  var scene = 'products';
  var u = String(location.href);
  if (/SearchScene=suppliers/i.test(u) || /[?&]scene=suppliers/i.test(u)) scene = 'suppliers';
  else if (/\/companies?\//i.test(location.pathname)) scene = 'suppliers';

  return {
    ok: unique.length > 0,
    page: 'search',
    scene: scene,
    url: location.href,
    title: document.title,
    count: unique.length,
    candidates: unique,
    bodySample: (document.body ? document.body.innerText : '').slice(0, 3000),
  };
}
