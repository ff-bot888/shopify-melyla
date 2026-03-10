import { ThemeEvents, CartAddEvent, CartErrorEvent } from '@theme/events';

const PRICE_SELECTORS = [
  'product-price .price',
  '[data-testid="sticky-price-display"] .price',
  '.sticky-add-to-cart__price .price',
  '.price .price-item--sale',
  '.price .price-item--regular',
  '.price-item--last',
  '.price-item',
];

function getProductFormSection() {
  return document.querySelector('[data-testid="product-information"]');
}

let shouldOpenCartDrawer = false;
let globalCartListenersBound = false;
let loadingFallbackTimer = null;
let cachedMelylaProductConfig = null;

function toFiniteNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getMelylaProductConfig() {
  if (cachedMelylaProductConfig) return cachedMelylaProductConfig;

  const configNode = document.querySelector('script[data-melyla-variant-subtitles]');
  if (!(configNode instanceof HTMLScriptElement)) {
    cachedMelylaProductConfig = {};
    return cachedMelylaProductConfig;
  }

  try {
    cachedMelylaProductConfig = JSON.parse(configNode.textContent || '{}') || {};
  } catch (error) {
    console.error('Failed to parse product config:', error);
    cachedMelylaProductConfig = {};
  }

  return cachedMelylaProductConfig;
}

function normalizeBundleConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const sourceHasData = Object.keys(source).length > 0;
  const hasEnabledField = Object.prototype.hasOwnProperty.call(source, 'bundle_enabled');
  const fallbackPaidCount = clamp(Math.round(toFiniteNumber(source.paid_count, 2)), 1, 20);
  const fallbackFreeCount = clamp(Math.round(toFiniteNumber(source.free_count, 3)), 0, 20);
  const discountPercent = clamp(toFiniteNumber(source.discount_percent, 21), 0, 100);
  const bundlePriceMultiplier = toFiniteNumber(
    source.bundle_price_multiplier,
    fallbackPaidCount * (1 - discountPercent / 100)
  );
  const bundleCompareMultiplier = toFiniteNumber(source.bundle_compare_multiplier, fallbackPaidCount);
  const cartQuantity = clamp(Math.round(toFiniteNumber(source.cart_quantity, fallbackPaidCount)), 1, 50);
  const paidLabel = String(source.paid_label || (discountPercent > 0 ? `${discountPercent}% OFF` : '')).trim();

  const badge = String(source.badge || 'BEST VALUE').trim();
  const savePrefix = String(source.save_prefix || 'You save').trim();
  const saveSuffix = String(source.save_suffix || 'with this bundle').trim();
  const freeLabel = String(source.free_label || 'FREE').trim();

  const rawItems = Array.isArray(source.items) ? source.items : [];
  const rawBundleByList = Array.isArray(source.bundle_by_raw)
    ? source.bundle_by_raw
    : source.bundle_by_raw
      ? [source.bundle_by_raw]
      : [];
  const neededItemCount = rawItems.length > 0 ? rawItems.length : fallbackPaidCount + fallbackFreeCount;
  const items = [];

  for (let index = 0; index < neededItemCount; index += 1) {
    const rawItem = rawItems[index] && typeof rawItems[index] === 'object' ? rawItems[index] : {};
    const freeByPosition = index >= fallbackPaidCount;
    const free = rawItem.free === true || (rawItem.free !== false && freeByPosition);
    const defaultName = free ? `Gift ${Math.max(1, index - fallbackPaidCount + 1)}` : `Bundle Item ${index + 1}`;
    const priceMultiplierDefault = free ? 0 : 1 - discountPercent / 100;
    const compareMultiplierDefault = 1;
    const name = String(rawItem.name || defaultName).trim();
    const discountLabel = String(rawItem.discount_label || (!free && paidLabel ? paidLabel : '')).trim();
    const priceMultiplier = Math.max(0, toFiniteNumber(rawItem.price_multiplier, priceMultiplierDefault));
    const compareMultiplier = Math.max(0, toFiniteNumber(rawItem.compare_multiplier, compareMultiplierDefault));
    const variantId = String(rawItem.variant_id || rawItem.variantId || '').trim();
    const isCurrentProduct = rawItem.is_current_product === true;
    const quantity = clamp(Math.round(toFiniteNumber(rawItem.quantity, 1)), 1, 50);
    const imageUrl = String(rawItem.image_url || rawItem.image || rawItem.image_src || '').trim();
    const imageAlt = String(rawItem.image_alt || rawItem.name || defaultName).trim();
    const subtext = String(rawItem.subtext || rawItem.subtitle || '').trim();
    const fixedPrice = String(rawItem.fixed_price || rawItem.fixedPrice || '').trim();
    const fixedCompare = String(rawItem.fixed_compare || rawItem.fixedCompare || '').trim();

    items.push({
      name,
      free,
      subtext,
      discountLabel,
      priceMultiplier,
      compareMultiplier,
      variantId,
      isCurrentProduct,
      quantity,
      imageUrl,
      imageAlt,
      fixedPrice,
      fixedCompare,
    });
  }

  const configuredPaidCount = items.filter((item) => !item.free).length;
  const configuredFreeCount = items.filter((item) => item.free).length;
  const targetPaidCount = Math.max(
    1,
    rawBundleByList.length + 1,
    Math.round(toFiniteNumber(source.paid_count, fallbackPaidCount))
  );

  // If paid lines are missing due to Liquid reference shape mismatch, recover from raw list.
  if (configuredPaidCount < targetPaidCount && rawBundleByList.length) {
    for (let i = 0; i < rawBundleByList.length && items.filter((item) => !item.free).length < targetPaidCount; i += 1) {
      const candidate = rawBundleByList[i];
      const ref = (candidate && typeof candidate === 'object')
        ? (candidate.value || candidate.product || candidate.reference || candidate)
        : candidate;
      const variant = ref.selected_or_first_available_variant
        || (Array.isArray(ref.variants) ? ref.variants[0] : null)
        || ref.variant
        || null;
      const variantId = String(variant?.id || '').trim();
      const imageUrl =
        String(
          variant?.featured_image?.src
          || variant?.featured_image?.url
          || variant?.featured_image
          || ref?.featured_image?.src
          || ref?.featured_image?.url
          || ref?.featured_image
          || ''
        ).trim();

      items.push({
        name: String(
          (ref && typeof ref === 'object' ? (ref.title || ref.name) : ref)
          || `Bundle Item ${items.filter((x) => !x.free).length + 1}`
        ).trim(),
        free: false,
        subtext: '',
        discountLabel: String(source.paid_label || '').trim(),
        priceMultiplier: 1,
        compareMultiplier: 1,
        variantId,
        isCurrentProduct: false,
        quantity: 1,
        imageUrl,
        imageAlt: String((ref && typeof ref === 'object' ? (ref.title || ref.name) : ref) || '').trim(),
        fixedPrice: '',
        fixedCompare: '',
      });
    }
  }

  const finalPaidCount = items.filter((item) => !item.free).length;
  const finalFreeCount = items.filter((item) => item.free).length;
  const paidCount = finalPaidCount > 0 ? finalPaidCount : fallbackPaidCount;
  const freeCount = finalFreeCount > 0 ? finalFreeCount : fallbackFreeCount;
  const headlineDefault = freeCount > 0 ? `Buy ${paidCount} Get ${freeCount} FREE` : `Buy ${paidCount}`;
  const subtitleDefault = freeCount > 0 ? `${paidCount} items + ${freeCount} free gifts` : `${paidCount} items`;
  const headline = String(source.headline || headlineDefault).trim();
  const subtitle = String(source.subtitle || subtitleDefault).trim();

  return {
    enabled: sourceHasData && rawItems.length > 0 && (hasEnabledField ? toBoolean(source.bundle_enabled, false) : true),
    paidCount,
    freeCount,
    discountPercent,
    cartQuantity,
    headline,
    subtitle,
    badge,
    paidLabel,
    savePrefix,
    saveSuffix,
    freeLabel,
    bundlePriceMultiplier: Math.max(0, bundlePriceMultiplier),
    bundleCompareMultiplier: Math.max(0, bundleCompareMultiplier),
    items,
  };
}

function getBundleConfig() {
  const config = getMelylaProductConfig();
  const normalized = normalizeBundleConfig(config?.bundleConfig);
  if (!normalized.enabled) return normalized;

  // Hard guarantee: paid list must always include current product as the first paid line.
  const paidItems = normalized.items.filter((item) => !item.free);
  const currentIndex = paidItems.findIndex((item) => item.isCurrentProduct === true);
  if (currentIndex < 0) {
    normalized.items.unshift({
      name: String(config?.productTitle || 'Current Product'),
      free: false,
      subtext: '',
      discountLabel: normalized.paidLabel || '',
      priceMultiplier: 1,
      compareMultiplier: 1,
      variantId: '',
      isCurrentProduct: true,
      quantity: 1,
      imageUrl: '',
      imageAlt: String(config?.productTitle || 'Current Product'),
      fixedPrice: '',
      fixedCompare: '',
    });
  } else if (currentIndex > 0) {
    // Move current product line to the first paid position for predictable UI.
    const currentItem = paidItems[currentIndex];
    normalized.items = [currentItem, ...normalized.items.filter((item) => item !== currentItem)];
  }

  normalized.paidCount = normalized.items.filter((item) => !item.free).length;
  normalized.freeCount = normalized.items.filter((item) => item.free).length;
  const expectedPaidCount = Math.max(
    normalized.paidCount,
    Math.max(1, Math.round(toFiniteNumber(config?.bundleConfig?.paid_count, normalized.paidCount || 1)))
  );
  while (normalized.items.filter((item) => !item.free).length < expectedPaidCount) {
    normalized.items.push({
      name: `Bundle Item ${normalized.items.filter((item) => !item.free).length + 1}`,
      free: false,
      subtext: '',
      discountLabel: normalized.paidLabel || '',
      priceMultiplier: 1,
      compareMultiplier: 1,
      variantId: '',
      isCurrentProduct: false,
      quantity: 1,
      imageUrl: '',
      imageAlt: '',
      fixedPrice: '',
      fixedCompare: '',
    });
  }
  normalized.paidCount = normalized.items.filter((item) => !item.free).length;
  // Always derive display copy from resolved data, not hand-entered subtitle text.
  normalized.headline = normalized.freeCount > 0
    ? `Buy ${normalized.paidCount} Get ${normalized.freeCount} FREE`
    : `Buy ${normalized.paidCount}`;
  normalized.subtitle = normalized.freeCount > 0
    ? `${normalized.paidCount} items + ${normalized.freeCount} free gifts`
    : `${normalized.paidCount} items`;
  return normalized;
}

function getConfiguredPaidCartQty(bundleConfig) {
  return bundleConfig.items
    .filter((item) => !item.free && (item.variantId || item.isCurrentProduct))
    .reduce((sum, item) => sum + Math.max(1, Math.round(item.quantity || 1)), 0);
}

function setAddToCartLoading(scope, loading) {
  const button = scope?.querySelector('.add-to-cart-button.button');
  if (!button) return;

  if (loading) {
    if (!button.dataset.melylaWasDisabled) {
      button.dataset.melylaWasDisabled = button.disabled ? 'true' : 'false';
    }
    button.classList.add('is-melyla-loading');
    button.disabled = true;
  } else {
    button.classList.remove('is-melyla-loading');
    const wasDisabled = button.dataset.melylaWasDisabled === 'true';
    delete button.dataset.melylaWasDisabled;
    if (!wasDisabled) button.disabled = false;
  }
}

function getQuantityInput(scope) {
  return scope?.querySelector('quantity-selector-component input[name="quantity"]') || null;
}

function setQuantity(scope, qty) {
  const input = getQuantityInput(scope);
  if (!input) return;

  const next = String(Math.max(1, qty));
  input.value = next;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
}

function findPriceText(scope) {
  for (const selector of PRICE_SELECTORS) {
    const el = scope.querySelector(selector);
    if (el && el.textContent) {
      const value = el.textContent.replace(/\s+/g, ' ').trim();
      if (value) return value;
    }
  }
  return '';
}

function findComparePriceText(scope) {
  const selectors = [
    'product-price .compare-at-price',
    '[data-testid="sticky-price-display"] .compare-at-price',
    '.sticky-add-to-cart__price .compare-at-price',
    '.price .price-item--regular',
  ];

  for (const selector of selectors) {
    const el = scope.querySelector(selector);
    if (el?.textContent) return el.textContent.replace(/\s+/g, ' ').trim();
  }

  return '';
}

function parseMoney(text) {
  const trimmed = (text || '').trim();
  const match = trimmed.match(/^([^0-9]*)([0-9][0-9,]*(?:[.][0-9]+)?)(.*)$/);
  if (!match) return null;

  const prefix = match[1] || '';
  const rawNumber = (match[2] || '').replace(/,/g, '');
  const value = Number(rawNumber);
  const suffix = match[3] || '';
  if (!Number.isFinite(value)) return null;

  const dotIndex = rawNumber.indexOf('.');
  const decimals = dotIndex >= 0 ? rawNumber.length - dotIndex - 1 : 2;
  return { prefix, value, suffix, decimals };
}

function formatMoney(parts, multiplier = 1) {
  const num = parts.value * multiplier;
  return `${parts.prefix}${num.toFixed(parts.decimals)}${parts.suffix}`;
}

function formatMoneyValue(parts, value) {
  return `${parts.prefix}${Number(value).toFixed(parts.decimals)}${parts.suffix}`;
}

function ensureOfferCardDetails(scope) {
  const group = scope.querySelector('[data-melyla-offer-cards]');
  if (!group) return;
  const bundleConfig = getBundleConfig();

  const cards = Array.from(group.querySelectorAll('.melyla-offer-card'));
  cards.forEach((card) => {
    let details = card.querySelector('.melyla-offer-card__details');
    const options = card.querySelector('.melyla-offer-card__options');
    if (!details) {
      details = document.createElement('div');
      details.className = 'melyla-offer-card__details';
      if (options) details.append(options);
      card.append(details);
    }
  });

  const bundleCard =
    group.querySelector('.melyla-offer-card[data-offer-type="bundle"]')
    || group.querySelector('.melyla-offer-card[data-offer-qty="2"]')
    || cards[1];
  if (!bundleCard) return;
  bundleCard.setAttribute('data-offer-type', 'bundle');

  let details = bundleCard.querySelector('.melyla-offer-card__details');
  if (!details) return;

  if (!bundleConfig.enabled) {
    bundleCard.setAttribute('hidden', 'hidden');
    bundleCard.setAttribute('aria-hidden', 'true');
    const oldItems = details.querySelector('.melyla-bundle-items');
    if (oldItems) oldItems.remove();

    const singleCard = group.querySelector('.melyla-offer-card[data-offer-qty="1"]') || cards[0];
    cards.forEach((item) => {
      const active = item === singleCard;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    setQuantity(scope, 1);
    return;
  }

  bundleCard.removeAttribute('hidden');
  bundleCard.removeAttribute('aria-hidden');
  const configuredPaidQty = getConfiguredPaidCartQty(bundleConfig);
  bundleCard.setAttribute('data-offer-qty', String(configuredPaidQty > 0 ? configuredPaidQty : bundleConfig.cartQuantity));

  if (!details.querySelector('.melyla-offer-card__options')) {
    const options = document.createElement('div');
    options.className = 'melyla-offer-card__options';
    options.innerHTML =
      '<span data-label="Size" data-offer-option="1">Size</span><span data-label="Material" data-offer-option="2">Material</span>';
    details.prepend(options);
  }

  const badgeEl = bundleCard.querySelector('.badge');
  if (badgeEl) badgeEl.textContent = bundleConfig.badge;

  const titleEl = bundleCard.querySelector('h5');
  if (titleEl) {
    titleEl.textContent = bundleConfig.headline;
    if (bundleConfig.paidLabel) {
      const off = document.createElement('em');
      off.className = 'off';
      off.textContent = bundleConfig.paidLabel;
      titleEl.append(' ');
      titleEl.append(off);
    }
  }

  const subtitleEl = bundleCard.querySelector('p');
  if (subtitleEl) subtitleEl.textContent = bundleConfig.subtitle;

  const oldItems = details.querySelector('.melyla-bundle-items');
  if (oldItems) oldItems.remove();

  const bundleItems = document.createElement('div');
  bundleItems.className = 'melyla-bundle-items';
  const fallbackThumb = group.querySelector('.melyla-offer-card[data-offer-qty="1"] .melyla-offer-card__thumb');
  const fallbackThumbSrc = fallbackThumb?.getAttribute('src') || '';
  const fallbackThumbAlt = fallbackThumb?.getAttribute('alt') || '';

  bundleConfig.items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = `melyla-bundle-item${item.free ? ' is-free' : ''}`;

    const thumb = document.createElement('span');
    thumb.className = 'melyla-bundle-item__thumb';
    const thumbSrc = item.imageUrl || fallbackThumbSrc;
    if (thumbSrc) {
      const img = document.createElement('img');
      img.src = thumbSrc;
      img.alt = item.imageAlt || fallbackThumbAlt || item.name;
      img.loading = 'lazy';
      thumb.append(img);
    }

    const meta = document.createElement('div');
    meta.className = 'melyla-bundle-item__meta';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;
    if (!item.free && item.discountLabel) {
      const label = document.createElement('em');
      label.textContent = item.discountLabel;
      name.append(' ');
      name.append(label);
    }
    meta.append(name);
    if (item.subtext) {
      const sub = document.createElement('span');
      sub.className = 'subtext';
      sub.textContent = item.subtext;
      meta.append(sub);
    }

    const price = document.createElement('span');
    price.className = 'price';
    if (item.free) {
      price.textContent = bundleConfig.freeLabel;
    } else {
      price.setAttribute('data-bundle-line', String(index + 1));
      price.textContent = '$0.00';
    }

    const compare = document.createElement('span');
    compare.className = 'compare';
    compare.setAttribute('data-bundle-compare', String(index + 1));

    row.append(thumb, meta, price, compare);
    bundleItems.append(row);
  });

  const save = document.createElement('div');
  save.className = 'melyla-bundle-save';
  save.innerHTML = `${bundleConfig.savePrefix} <strong data-bundle-save>$0.00</strong> ${bundleConfig.saveSuffix}`;
  bundleItems.append(save);

  details.append(bundleItems);
}

function syncBundleBreakdown(scope, parsed, compareParsed, bundleConfig) {
  const group = scope.querySelector('[data-melyla-offer-cards]');
  if (!group || !parsed || !bundleConfig.enabled) return;
  const saveEl = group.querySelector('[data-bundle-save]');
  const baseCompare = compareParsed || parsed;
  let actualTotal = 0;
  let compareTotal = 0;

  bundleConfig.items.forEach((item, index) => {
    const lineEl = group.querySelector(`[data-bundle-line="${index + 1}"]`);
    const compareEl = group.querySelector(`[data-bundle-compare="${index + 1}"]`);
    const fixedPriceParsed = parseMoney(item.fixedPrice || '');
    const fixedCompareParsed = parseMoney(item.fixedCompare || '');
    const qty = Math.max(1, Math.round(item.quantity || 1));

    if (!item.free) {
      const lineText = fixedPriceParsed ? item.fixedPrice : formatMoney(parsed, item.priceMultiplier);
      if (lineEl) lineEl.textContent = lineText;
      actualTotal += (fixedPriceParsed ? fixedPriceParsed.value : parsed.value * item.priceMultiplier) * qty;
    }

    const compareText = fixedCompareParsed
      ? item.fixedCompare
      : formatMoney(baseCompare, item.compareMultiplier || 1);
    if (compareEl) compareEl.textContent = compareText;
    compareTotal += (fixedCompareParsed ? fixedCompareParsed.value : baseCompare.value * (item.compareMultiplier || 1)) * qty;
  });

  if (saveEl) {
    const save = Math.max(0, compareTotal - actualTotal);
    const money = { ...parsed, value: save };
    saveEl.textContent = formatMoney(money, 1);
  }
}

function syncOfferCardState(scope) {
  const group = scope.querySelector('[data-melyla-offer-cards]');
  if (!group) return;

  const cards = Array.from(group.querySelectorAll('.melyla-offer-card'));
  cards.forEach((card) => {
    const active = card.classList.contains('is-active');
    card.setAttribute('data-state', active ? 'open' : 'closed');
  });
}

function syncAddToCartPrice(scope) {
  const addToCartButton = scope.querySelector('.add-to-cart-button.button');
  if (!addToCartButton) return;

  const price = findPriceText(scope);
  if (!price) {
    addToCartButton.removeAttribute('data-melyla-price');
    const badge = addToCartButton.querySelector('.melyla-cart-price-badge');
    if (badge) badge.remove();
    return;
  }

  const compare = findComparePriceText(scope);
  addToCartButton.setAttribute('data-melyla-price', price);
  if (compare) {
    addToCartButton.setAttribute('data-melyla-compare', compare);
  } else {
    addToCartButton.removeAttribute('data-melyla-compare');
  }

  let badge = addToCartButton.querySelector('.melyla-cart-price-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'melyla-cart-price-badge';
    addToCartButton.append(badge);
  }

  if (compare) {
    badge.innerHTML = `<s>${compare}</s> <strong>${price}</strong>`;
    addToCartButton.dataset.hasCompare = 'true';
  } else {
    badge.innerHTML = `<strong>${price}</strong>`;
    addToCartButton.dataset.hasCompare = 'false';
  }
}

function syncOfferCardPrices(scope) {
  const group = scope.querySelector('[data-melyla-offer-cards]');
  if (!group) return;
  const bundleConfig = getBundleConfig();

  const price = findPriceText(scope);
  if (!price) return;

  const single = group.querySelector('[data-offer-price=\"single\"]');
  const bundle = group.querySelector('[data-offer-price=\"bundle\"]');
  const bundleCompare = group.querySelector('[data-offer-compare=\"bundle\"]');
  const bundleCard = group.querySelector('.melyla-offer-card[data-offer-type="bundle"]');

  const parsed = parseMoney(price);
  if (single) single.textContent = price;
  if (!bundleConfig.enabled) {
    if (bundle) bundle.textContent = '';
    if (bundleCompare) {
      bundleCompare.textContent = '';
      bundleCompare.classList.remove('is-visible');
    }
    if (bundleCard) bundleCard.setAttribute('hidden', 'hidden');
    return;
  }

  if (bundle) {
    if (parsed) {
      const baseCompare = parseMoney(findComparePriceText(scope)) || parsed;
      const paidItems = bundleConfig.items.filter((item) => !item.free);
      const hasConfiguredPaid = paidItems.some((item) => item.variantId || item.isCurrentProduct);

      if (hasConfiguredPaid) {
        let total = 0;
        paidItems.forEach((item) => {
          const qty = Math.max(1, Math.round(item.quantity || 1));
          const fixedPriceParsed = parseMoney(item.fixedPrice || '');
          const line = fixedPriceParsed ? fixedPriceParsed.value : parsed.value * (item.priceMultiplier || 1);
          total += line * qty;
        });
        bundle.textContent = formatMoneyValue(parsed, total);

        if (bundleCompare) {
          let compareTotal = 0;
          paidItems.forEach((item) => {
            const qty = Math.max(1, Math.round(item.quantity || 1));
            const fixedCompareParsed = parseMoney(item.fixedCompare || '');
            const lineCompare = fixedCompareParsed
              ? fixedCompareParsed.value
              : baseCompare.value * (item.compareMultiplier || 1);
            compareTotal += lineCompare * qty;
          });
          bundleCompare.textContent = formatMoneyValue(baseCompare, compareTotal);
          bundleCompare.classList.add('is-visible');
        }
      } else {
        bundle.textContent = formatMoney(parsed, bundleConfig.bundlePriceMultiplier);
      }
    } else {
      bundle.textContent = `${bundleConfig.paidCount}x ${price}`;
    }
  }

  const compare = findComparePriceText(scope);
  const compareParsed = parseMoney(compare);
  if (bundleCompare && bundleCompare.textContent === '') {
    if (compareParsed) {
      bundleCompare.textContent = formatMoney(compareParsed, bundleConfig.bundleCompareMultiplier);
      bundleCompare.classList.add('is-visible');
    } else {
      bundleCompare.textContent = '';
      bundleCompare.classList.remove('is-visible');
    }
  }

  syncBundleBreakdown(scope, parsed, compareParsed, bundleConfig);
}

function syncInstallments(scope) {
  const el = scope.querySelector('.melyla-pdp-installments');
  if (!el) return;

  const priceText = findPriceText(scope);
  const parsed = parseMoney(priceText);
  if (!parsed) return;

  const installment = formatMoney(parsed, 0.25);
  const strong = el.querySelector('strong');
  if (strong) strong.textContent = installment;
}

function syncVariantSubtitleTitle(scope, event) {
  const targetMainTitle = scope.querySelector('.product-details h1');
  if (!(targetMainTitle instanceof HTMLElement)) return;
  const subtitleConfig = getMelylaProductConfig();

  const variantFromEvent = event?.detail?.variant?.id;
  const variantFromUrl = new URL(window.location.href).searchParams.get('variant');
  const variantFromForm = scope.querySelector('form[data-type="add-to-cart-form"] input[name="id"]')?.value;
  const variantId = String(variantFromEvent || variantFromForm || variantFromUrl || '');
  const subtitle = subtitleConfig?.variants?.[variantId];
  const fallbackTitle = subtitleConfig?.productTitle || '';
  const displayTitle = (subtitle || fallbackTitle || '').trim();
  if (!displayTitle) return;

  targetMainTitle.textContent = `AFROYLA ${displayTitle}`;

  const sourceHtml = event?.detail?.data?.html;
  if (!sourceHtml) return;
  const sourceViewTitleLink = sourceHtml.querySelector('[data-testid="product-information"] .view-product-title a.link');
  const targetViewTitleLink = scope.querySelector('.view-product-title a.link');
  if (sourceViewTitleLink instanceof HTMLAnchorElement && targetViewTitleLink instanceof HTMLAnchorElement) {
    targetViewTitleLink.href = sourceViewTitleLink.href;
  }
}

function initJudgeMeReviews(scope) {
  const root = scope.querySelector('[data-testid="melyla-product-reviews"]');
  if (!root) return;

  const widget = root.querySelector('#judgeme_product_reviews');
  const badge = document.querySelector('[data-testid="product-information"] .jdgm-preview-badge');
  const config = getMelylaProductConfig();
  const productId = String(config?.productId || '');

  if (productId) {
    if (widget instanceof HTMLElement && !widget.getAttribute('data-id')) {
      widget.setAttribute('data-id', productId);
    }
    if (badge instanceof HTMLElement && !badge.getAttribute('data-id')) {
      badge.setAttribute('data-id', productId);
    }
  }

  root.classList.add('is-ready');

  const jdgm = window.jdgm;
  if (jdgm) {
    try {
      jdgm.loadBadges?.();
      jdgm.loadAllWidgets?.();
      jdgm.initializeWidgets?.();
    } catch (error) {
      console.error('Judge.me refresh failed:', error);
    }
  }
}

function trySelectFirstAvailableVariant(scope) {
  const variantPicker = scope.querySelector('variant-picker');
  if (!variantPicker) return;

  const fieldsets = Array.from(variantPicker.querySelectorAll('fieldset.variant-option'));
  if (fieldsets.length) {
    let changed = false;

    fieldsets.forEach((fieldset) => {
      const checked = fieldset.querySelector('input[type="radio"]:checked');
      const isCheckedAvailable = checked?.getAttribute('data-option-available') === 'true';
      if (isCheckedAvailable) return;

      const firstAvailable = fieldset.querySelector('input[type="radio"][data-option-available="true"]');
      if (firstAvailable instanceof HTMLInputElement && firstAvailable !== checked) {
        firstAvailable.checked = true;
        firstAvailable.dispatchEvent(new Event('input', { bubbles: true }));
        firstAvailable.dispatchEvent(new Event('change', { bubbles: true }));
        changed = true;
      }
    });

    if (changed) return;
  }

  const selects = Array.from(variantPicker.querySelectorAll('select'));
  selects.forEach((select) => {
    if (!(select instanceof HTMLSelectElement)) return;

    const selected = select.options[select.selectedIndex];
    const selectedUnavailable = selected?.textContent?.toLowerCase().includes('unavailable');
    if (!selectedUnavailable) return;

    const next = Array.from(select.options).find((opt) => !opt.textContent?.toLowerCase().includes('unavailable'));
    if (!next || next.value === select.value) return;

    select.value = next.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function recoverUnavailableVariantFromUrl(scope) {
  const addButton = scope.querySelector('.add-to-cart-button.button');
  if (!addButton || !addButton.disabled) return;

  const text = addButton.textContent?.toLowerCase() || '';
  const looksUnavailable = text.includes('unavailable') || text.includes('sold out');
  if (!looksUnavailable) return;

  const url = new URL(window.location.href);
  const selectedVariant = url.searchParams.get('variant');
  if (!selectedVariant) return;

  // If URL points to an unavailable variant, fall back to default product URL
  // so Shopify selects the first available variant again.
  const storageKey = `melyla-unavailable-variant-recovered:${url.pathname}`;
  if (sessionStorage.getItem(storageKey) === selectedVariant) return;

  sessionStorage.setItem(storageKey, selectedVariant);
  url.searchParams.delete('variant');
  window.location.replace(url.toString());
}

async function forceSwitchToFirstAvailableVariant(scope) {
  const addButton = scope.querySelector('.add-to-cart-button.button');
  if (!addButton || !addButton.disabled) return;

  const text = addButton.textContent?.toLowerCase() || '';
  const looksUnavailable = text.includes('unavailable') || text.includes('sold out');
  if (!looksUnavailable) return;

  const pathMatch = window.location.pathname.match(/^\/products\/([^/?#]+)/);
  if (!pathMatch) return;

  const handle = pathMatch[1];
  const productJsonUrl = `/products/${handle}.js`;

  const loopKey = `melyla-force-variant:${window.location.pathname}`;
  const currentVariant = new URL(window.location.href).searchParams.get('variant') || 'none';
  const attempted = sessionStorage.getItem(loopKey);
  if (attempted === currentVariant) return;

  try {
    const res = await fetch(productJsonUrl, { credentials: 'same-origin' });
    if (!res.ok) return;
    const product = await res.json();
    const availableVariant = Array.isArray(product?.variants) ? product.variants.find((v) => v.available) : null;
    if (!availableVariant?.id) return;

    sessionStorage.setItem(loopKey, currentVariant);
    const url = new URL(window.location.href);
    url.searchParams.set('variant', String(availableVariant.id));
    window.location.replace(url.toString());
  } catch (error) {
    console.error('Failed to switch to an available variant:', error);
  }
}

function getAddToCartTextNode(button) {
  if (!button) return null;
  return (
    button.querySelector('.add-to-cart-text__content > span') ||
    button.querySelector('.add-to-cart-text__content span span') ||
    null
  );
}

function setAddToCartEnabledState(scope, enabled) {
  const addButton = scope.querySelector('.add-to-cart-button.button');
  if (!addButton) return;

  addButton.disabled = !enabled;
  const addToCartContainer = scope.querySelector('add-to-cart-component');
  if (enabled) {
    addToCartContainer?.enable?.();
  } else {
    addToCartContainer?.disable?.();
  }

  const textNode = getAddToCartTextNode(addButton);
  if (textNode) {
    textNode.textContent = enabled ? 'ADD TO CART' : 'UNAVAILABLE';
  }
}

async function hardRecoverVariantAvailability(scope) {
  const addButton = scope.querySelector('.add-to-cart-button.button');
  const form = scope.querySelector('form[data-type="add-to-cart-form"]');
  const idInput = form?.querySelector('input[name="id"]');
  if (!addButton || !form || !(idInput instanceof HTMLInputElement)) return;

  if (!addButton.disabled) return;

  const pathMatch = window.location.pathname.match(/^\/products\/([^/?#]+)/);
  if (!pathMatch) return;

  try {
    const res = await fetch(`/products/${pathMatch[1]}.js`, { credentials: 'same-origin' });
    if (!res.ok) return;
    const product = await res.json();
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    if (!variants.length) return;

    const urlVariant = new URL(window.location.href).searchParams.get('variant');
    const currentAvailable = variants.find((v) => String(v.id) === String(urlVariant) && v.available);
    const availableVariant = currentAvailable || variants.find((v) => v.available);
    if (!availableVariant?.id) return;

    const optionValues = Array.isArray(availableVariant.options)
      ? availableVariant.options
      : [availableVariant.option1, availableVariant.option2, availableVariant.option3].filter(Boolean);
    optionValues.forEach((value, index) => {
      if (value) setVariantOptionValue(scope, index, String(value));
    });

    idInput.value = String(availableVariant.id);
    idInput.dispatchEvent(new Event('input', { bubbles: true }));
    idInput.dispatchEvent(new Event('change', { bubbles: true }));

    setAddToCartEnabledState(scope, true);

    const sticky = document.querySelector('sticky-add-to-cart');
    if (sticky) sticky.setAttribute('data-variant-available', 'true');

    const url = new URL(window.location.href);
    url.searchParams.set('variant', String(availableVariant.id));
    history.replaceState({}, '', url.toString());
  } catch (error) {
    console.error('Failed hard recovery for available variant:', error);
  }
}

function scheduleHardRecovery(scope) {
  if (!scope) return;
  const delays = [30, 120, 300, 700, 1400];
  delays.forEach((delay) => {
    window.setTimeout(() => {
      hardRecoverVariantAvailability(scope);
    }, delay);
  });
}

async function activateFirstAvailableVariantInForm(scope) {
  const addButton = scope.querySelector('.add-to-cart-button.button');
  const form = scope.querySelector('form[data-type="add-to-cart-form"]');
  const idInput = form?.querySelector('input[name="id"]');
  if (!addButton || !form || !(idInput instanceof HTMLInputElement)) return;

  if (!addButton.disabled) return;

  const pathMatch = window.location.pathname.match(/^\/products\/([^/?#]+)/);
  if (!pathMatch) return;
  const handle = pathMatch[1];

  try {
    const res = await fetch(`/products/${handle}.js`, { credentials: 'same-origin' });
    if (!res.ok) return;
    const product = await res.json();
    const availableVariant = Array.isArray(product?.variants) ? product.variants.find((v) => v.available) : null;
    if (!availableVariant?.id) return;

    idInput.value = String(availableVariant.id);
    idInput.dispatchEvent(new Event('input', { bubbles: true }));
    idInput.dispatchEvent(new Event('change', { bubbles: true }));

    setAddToCartEnabledState(scope, true);

    const url = new URL(window.location.href);
    url.searchParams.set('variant', String(availableVariant.id));
    history.replaceState({}, '', url.toString());
  } catch (error) {
    console.error('Failed to activate first available variant:', error);
  }
}

function getSelectedOptionValue(fieldset) {
  if (!fieldset) return '';
  const checked = fieldset.querySelector('input[type=\"radio\"]:checked');
  if (!checked) return '';

  const label = checked.closest('label');
  if (!label) return '';

  const textEl = label.querySelector('.variant-option__button-label__text');
  if (textEl?.textContent) return textEl.textContent.trim();

  return (checked.getAttribute('value') || '').trim();
}

function getVariantOptionGroups(scope) {
  const variantPicker = scope.querySelector('.variant-picker');
  if (!variantPicker) return [];

  const fieldsets = Array.from(variantPicker.querySelectorAll('fieldset.variant-option'));
  if (fieldsets.length) {
    return fieldsets.map((fieldset, index) => {
      const legend = (fieldset.querySelector('legend')?.textContent || `Option ${index + 1}`).trim();
      const inputs = Array.from(fieldset.querySelectorAll('input[type="radio"]'));
      const values = Array.from(
        new Set(
          inputs
            .map((input) => (input.getAttribute('value') || '').trim())
            .filter(Boolean)
        )
      );
      return { index, label: legend, values, fieldset };
    });
  }

  const selects = Array.from(variantPicker.querySelectorAll('select'));
  return selects.map((select, index) => {
    const labelEl = select.closest('.variant-option')?.querySelector('label,legend');
    const label = (labelEl?.textContent || `Option ${index + 1}`).trim();
    const values = Array.from(select.options).map((opt) => opt.value).filter(Boolean);
    return { index, label, values, select };
  });
}

function setVariantOptionValue(scope, optionIndex, value) {
  const variantPicker = scope.querySelector('.variant-picker');
  if (!variantPicker) return;

  const fieldsets = Array.from(variantPicker.querySelectorAll('fieldset.variant-option'));
  if (fieldsets.length > optionIndex) {
    const fieldset = fieldsets[optionIndex];
    const target = fieldset.querySelector(`input[type="radio"][value="${CSS.escape(value)}"]`);
    if (target) {
      target.checked = true;
      target.dispatchEvent(new Event('change', { bubbles: true }));
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }

  const selects = Array.from(variantPicker.querySelectorAll('select'));
  const select = selects[optionIndex];
  if (select) {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function ensureOfferOptionSelects(scope) {
  const group = scope.querySelector('[data-melyla-offer-cards]');
  if (!group) return;

  const optionGroups = getVariantOptionGroups(scope).slice(0, 2);
  const optionContainers = Array.from(group.querySelectorAll('.melyla-offer-card__options'));
  if (optionGroups.length === 0) {
    optionContainers.forEach((container) => {
      container.setAttribute('hidden', 'hidden');
      container.innerHTML = '';
    });
    return;
  }

  optionContainers.forEach((container) => {
    container.removeAttribute('hidden');
    if (container.dataset.enhanced === 'true') return;
    container.dataset.enhanced = 'true';
    container.innerHTML = '';

    optionGroups.forEach((opt) => {
      const wrap = document.createElement('div');
      wrap.className = 'melyla-offer-select';

      const label = document.createElement('label');
      label.textContent = opt.label;

      const select = document.createElement('select');
      select.setAttribute('data-offer-select', String(opt.index + 1));
      opt.values.forEach((v) => {
        const option = document.createElement('option');
        option.value = v;
        option.textContent = v;
        select.append(option);
      });

      select.addEventListener('change', () => {
        setVariantOptionValue(scope, opt.index, select.value);
      });

      wrap.append(label, select);
      container.append(wrap);
    });
  });
}

function syncOfferOptions(scope) {
  const group = scope.querySelector('[data-melyla-offer-cards]');
  if (!group) return;

  const optionGroups = getVariantOptionGroups(scope).slice(0, 2);
  if (optionGroups.length === 0) {
    const optionContainers = Array.from(group.querySelectorAll('.melyla-offer-card__options'));
    optionContainers.forEach((container) => {
      container.setAttribute('hidden', 'hidden');
      container.innerHTML = '';
    });
    return;
  }

  const fieldsets = Array.from(scope.querySelectorAll('.variant-picker fieldset.variant-option'));
  if (fieldsets.length === 0) return;

  const option1 = getSelectedOptionValue(fieldsets[0]);
  const option2 = getSelectedOptionValue(fieldsets[1]);

  const option1Els = Array.from(group.querySelectorAll('[data-offer-option=\"1\"]'));
  const option2Els = Array.from(group.querySelectorAll('[data-offer-option=\"2\"]'));
  const option1Selects = Array.from(group.querySelectorAll('select[data-offer-select=\"1\"]'));
  const option2Selects = Array.from(group.querySelectorAll('select[data-offer-select=\"2\"]'));

  option1Els.forEach((el) => {
    if (option1) el.textContent = option1;
  });
  option2Els.forEach((el) => {
    if (option2) el.textContent = option2;
  });
  option1Selects.forEach((el) => {
    if (option1) el.value = option1;
  });
  option2Selects.forEach((el) => {
    if (option2) el.value = option2;
  });
}

function bindOfferCards(scope) {
  const group = scope.querySelector('[data-melyla-offer-cards]');
  if (!group || group.dataset.bound === 'true') return;
  group.dataset.bound = 'true';
  ensureOfferCardDetails(scope);

  const cards = Array.from(group.querySelectorAll('.melyla-offer-card'));
  cards.forEach((card) => {
    card.addEventListener('click', () => {
      cards.forEach((item) => {
        const active = item === card;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', active ? 'true' : 'false');
      });

      const qty = Number(card.getAttribute('data-offer-qty') || '1');
      setQuantity(scope, qty);
      syncOfferCardState(scope);
    });
  });

  syncOfferCardState(scope);
}

function getCartSectionIds() {
  const components = document.querySelectorAll('cart-items-component');
  const ids = new Set();
  components.forEach((item) => {
    if (item instanceof HTMLElement && item.dataset.sectionId) {
      ids.add(item.dataset.sectionId);
    }
  });
  return Array.from(ids);
}

function mergeCartItems(items) {
  const map = new Map();
  items.forEach((item) => {
    const id = Number(item?.id);
    const quantity = Number(item?.quantity);
    if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(quantity) || quantity <= 0) return;
    map.set(id, (map.get(id) || 0) + quantity);
  });
  return Array.from(map.entries()).map(([id, quantity]) => ({ id, quantity }));
}

function buildBundleCartItems(scope, form) {
  const group = scope.querySelector('[data-melyla-offer-cards]');
  if (!group) return null;
  const config = getBundleConfig();
  if (!config.enabled) return null;

  const activeBundleCard = group.querySelector('.melyla-offer-card.is-active[data-offer-type="bundle"]');
  if (!activeBundleCard) return null;

  const variantInput = form.querySelector('input[name="id"]');
  const selectedVariantId = Number(variantInput?.value || '');
  if (!Number.isFinite(selectedVariantId) || selectedVariantId <= 0) return null;

  const qtyInput = getQuantityInput(scope);
  const selectedQty = Number(qtyInput?.value || activeBundleCard.getAttribute('data-offer-qty') || '1');
  const paidQuantity = Math.max(1, Math.round(selectedQty));

  const items = [];
  const configuredPaidItems = config.items.filter((item) => !item.free && (item.variantId || item.isCurrentProduct));
  if (configuredPaidItems.length) {
    configuredPaidItems.forEach((item) => {
      const paidVariantId = item.isCurrentProduct ? selectedVariantId : Number(item.variantId);
      if (!Number.isFinite(paidVariantId) || paidVariantId <= 0) return;
      items.push({
        id: paidVariantId,
        quantity: Math.max(1, Math.round(item.quantity || 1)),
      });
    });
  } else {
    items.push({ id: selectedVariantId, quantity: paidQuantity });
  }

  config.items
    .filter((item) => item.free && item.variantId)
    .forEach((item) => {
      const giftVariantId = Number(item.variantId);
      if (!Number.isFinite(giftVariantId) || giftVariantId <= 0) return;
      items.push({
        id: giftVariantId,
        quantity: Math.max(1, Math.round(item.quantity || 1)),
      });
    });

  const merged = mergeCartItems(items);
  if (merged.length <= 1) return null;
  return merged;
}

async function addBundleItemsToCart(scope, form, items) {
  const sectionIds = getCartSectionIds();
  const payload = {
    items,
    sections: sectionIds.join(','),
    sections_url: window.location.pathname,
  };

  const response = await fetch(Theme.routes.cart_add_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
    credentials: 'same-origin',
  });
  const data = await response.json();

  if (!response.ok || data?.status) {
    const message = data?.message || 'Failed to add bundle to cart';
    const sourceId = form.getAttribute('id') || 'melyla-bundle-add';
    document.dispatchEvent(new CartErrorEvent(sourceId, message, data?.description, data?.errors));
    throw new Error(message);
  }

  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const sourceId = form.getAttribute('id') || String(items[0]?.id || '');
  const productId = form.getAttribute('data-product-id') || '';
  document.dispatchEvent(
    new CartAddEvent({}, sourceId, {
      source: 'melyla-pdp-bundle',
      itemCount: totalQuantity,
      productId,
      sections: data?.sections || {},
      variantId: String(items[0]?.id || ''),
    })
  );
}

function bindOtherStyles(scope) {
  const root = scope.querySelector('[data-melyla-other-styles]');
  if (!root || root.dataset.bound === 'true') return;
  root.dataset.bound = 'true';

  const moreBtn = root.querySelector('.melyla-other-styles__more');
  const tabs = Array.from(root.querySelectorAll('.melyla-other-styles__tabs button[data-filter]'));
  const items = Array.from(root.querySelectorAll('.melyla-other-style-item'));

  const applyFilter = (filter) => {
    const now = Date.now() / 1000;
    const recentWindow = 60 * 60 * 24 * 45;

    items.forEach((item) => {
      const isBest = item.getAttribute('data-best') === 'true';
      const created = Number(item.getAttribute('data-created') || '0');
      const isNew = created > 0 && now - created <= recentWindow;

      let visible = true;
      if (filter === 'best') visible = isBest;
      if (filter === 'new') visible = isNew;

      item.classList.toggle('is-hidden', !visible);
    });
  };

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((btn) => btn.classList.toggle('is-active', btn === tab));
      applyFilter(tab.getAttribute('data-filter') || 'all');
    });
  });

  if (moreBtn) {
    moreBtn.textContent = 'Show more designs';
    moreBtn.addEventListener('click', () => {
      root.classList.toggle('is-expanded');
      moreBtn.textContent = root.classList.contains('is-expanded') ? 'Show less designs' : 'Show more designs';
    });
  }

  applyFilter('all');
}

async function boot() {
  const scope = getProductFormSection();
  if (!scope) return;

  const form = scope.querySelector('form[data-type="add-to-cart-form"]');
  const addButton = scope.querySelector('.add-to-cart-button.button');
  if (addButton && addButton.dataset.melylaBound !== 'true') {
    addButton.dataset.melylaBound = 'true';
    addButton.addEventListener('click', () => {
      shouldOpenCartDrawer = true;
    });
  }
  if (form && form.dataset.melylaBound !== 'true') {
    form.dataset.melylaBound = 'true';
    form.addEventListener('submit', async (event) => {
      const bundleItems = buildBundleCartItems(scope, form);
      if (bundleItems) {
        event.preventDefault();
        shouldOpenCartDrawer = true;
        window.setTimeout(() => {
          setAddToCartLoading(scope, true);
        }, 0);

        if (loadingFallbackTimer) window.clearTimeout(loadingFallbackTimer);
        loadingFallbackTimer = window.setTimeout(() => {
          const latestScope = getProductFormSection();
          if (latestScope) setAddToCartLoading(latestScope, false);
          shouldOpenCartDrawer = false;
          loadingFallbackTimer = null;
        }, 8000);

        try {
          await addBundleItemsToCart(scope, form, bundleItems);
        } catch (error) {
          console.error('Bundle add to cart failed:', error);
        }
        return;
      }

      shouldOpenCartDrawer = true;
      // Defer one tick so submit is not blocked by early button disable.
      window.setTimeout(() => {
        setAddToCartLoading(scope, true);
      }, 0);

      if (loadingFallbackTimer) window.clearTimeout(loadingFallbackTimer);
      loadingFallbackTimer = window.setTimeout(() => {
        const latestScope = getProductFormSection();
        if (latestScope) setAddToCartLoading(latestScope, false);
        shouldOpenCartDrawer = false;
        loadingFallbackTimer = null;
      }, 8000);
    });
  }

  bindOfferCards(scope);
  ensureOfferCardDetails(scope);
  ensureOfferOptionSelects(scope);
  bindOtherStyles(scope);
  // Keep native Shopify variant availability flow intact.
  // Custom offer UI should not force-switch variant or button state.
  syncAddToCartPrice(scope);
  syncOfferCardPrices(scope);
  syncOfferOptions(scope);
  syncInstallments(scope);
  syncVariantSubtitleTitle(scope);
  initJudgeMeReviews(scope);

  const target = scope.closest('.shopify-section') || document;
  target.addEventListener(ThemeEvents.variantUpdate, (event) => {
    const nextScope = getProductFormSection();
    if (!nextScope) return;
    bindOfferCards(nextScope);
    ensureOfferCardDetails(nextScope);
    ensureOfferOptionSelects(nextScope);
    bindOtherStyles(nextScope);
    syncAddToCartPrice(nextScope);
    syncOfferCardPrices(nextScope);
    syncOfferOptions(nextScope);
    syncInstallments(nextScope);
    syncVariantSubtitleTitle(nextScope, event);
    initJudgeMeReviews(nextScope);
  });

  if (!globalCartListenersBound) {
    globalCartListenersBound = true;

    document.addEventListener(ThemeEvents.cartUpdate, () => {
      if (loadingFallbackTimer) {
        window.clearTimeout(loadingFallbackTimer);
        loadingFallbackTimer = null;
      }

      const currentScope = getProductFormSection();
      if (!shouldOpenCartDrawer) {
        if (currentScope) setAddToCartLoading(currentScope, false);
        return;
      }
      shouldOpenCartDrawer = false;

      const drawer = document.querySelector('cart-drawer-component');
      if (drawer && typeof drawer.open === 'function') {
        drawer.open();
      } else {
        const trigger = document.querySelector('[data-testid="cart-drawer-trigger"]');
        if (trigger instanceof HTMLElement) trigger.click();
      }

      // Unlock button after drawer animation kicks in.
      window.setTimeout(() => {
        const latestScope = getProductFormSection();
        if (latestScope) setAddToCartLoading(latestScope, false);
      }, 350);
    });

    document.addEventListener(ThemeEvents.cartError, () => {
      if (loadingFallbackTimer) {
        window.clearTimeout(loadingFallbackTimer);
        loadingFallbackTimer = null;
      }
      shouldOpenCartDrawer = false;
      const currentScope = getProductFormSection();
      if (currentScope) setAddToCartLoading(currentScope, false);
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
