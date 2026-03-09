import { ThemeEvents } from '@theme/events';

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

function ensureOfferCardDetails(scope) {
  const group = scope.querySelector('[data-melyla-offer-cards]');
  if (!group) return;

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

  const bundleCard = group.querySelector('.melyla-offer-card[data-offer-qty="2"]');
  if (!bundleCard) return;

  let details = bundleCard.querySelector('.melyla-offer-card__details');
  if (!details) return;

  if (!details.querySelector('.melyla-offer-card__options')) {
    const options = document.createElement('div');
    options.className = 'melyla-offer-card__options';
    options.innerHTML =
      '<span data-label="Size" data-offer-option="1">Size</span><span data-label="Material" data-offer-option="2">Material</span>';
    details.prepend(options);
  }

  if (details.querySelector('.melyla-bundle-items')) return;

  const bundleItems = document.createElement('div');
  bundleItems.className = 'melyla-bundle-items';
  bundleItems.innerHTML = `
    <div class="melyla-bundle-item">
      <span class="name">Leather Handbag <em>21% OFF</em></span>
      <span class="price" data-bundle-line="1">$0.00</span>
      <span class="compare" data-bundle-compare="1"></span>
    </div>
    <div class="melyla-bundle-item">
      <span class="name">Mini Satchel <em>21% OFF</em></span>
      <span class="price" data-bundle-line="2">$0.00</span>
      <span class="compare" data-bundle-compare="2"></span>
    </div>
    <div class="melyla-bundle-item is-free">
      <span class="name">Eclipse Makeup Bag</span>
      <span class="price">FREE</span>
      <span class="compare" data-bundle-compare="3"></span>
    </div>
    <div class="melyla-bundle-item is-free">
      <span class="name">Wallet</span>
      <span class="price">FREE</span>
      <span class="compare" data-bundle-compare="4"></span>
    </div>
    <div class="melyla-bundle-item is-free">
      <span class="name">Mini Wallet</span>
      <span class="price">FREE</span>
      <span class="compare" data-bundle-compare="5"></span>
    </div>
    <div class="melyla-bundle-save">You save <strong data-bundle-save>$0.00</strong> with this bundle</div>
  `;

  details.append(bundleItems);
}

function syncBundleBreakdown(scope, parsed, compareParsed) {
  const group = scope.querySelector('[data-melyla-offer-cards]');
  if (!group || !parsed) return;

  const line1 = group.querySelector('[data-bundle-line="1"]');
  const line2 = group.querySelector('[data-bundle-line="2"]');
  const compare1 = group.querySelector('[data-bundle-compare="1"]');
  const compare2 = group.querySelector('[data-bundle-compare="2"]');
  const compare3 = group.querySelector('[data-bundle-compare="3"]');
  const compare4 = group.querySelector('[data-bundle-compare="4"]');
  const compare5 = group.querySelector('[data-bundle-compare="5"]');
  const saveEl = group.querySelector('[data-bundle-save]');

  if (line1) line1.textContent = formatMoney(parsed, 0.79);
  if (line2) line2.textContent = formatMoney(parsed, 0.61);

  if (compare1) compare1.textContent = formatMoney(parsed, 1);
  if (compare2) compare2.textContent = formatMoney(parsed, 0.77);
  if (compare3) compare3.textContent = formatMoney(parsed, 0.28);
  if (compare4) compare4.textContent = formatMoney(parsed, 0.35);
  if (compare5) compare5.textContent = formatMoney(parsed, 0.28);

  if (saveEl) {
    if (compareParsed) {
      const save = compareParsed.value * 2 - parsed.value * 2;
      const money = { ...parsed, value: Math.max(0, save) };
      saveEl.textContent = formatMoney(money, 1);
    } else {
      saveEl.textContent = formatMoney(parsed, 1.28);
    }
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

  const price = findPriceText(scope);
  if (!price) return;

  const single = group.querySelector('[data-offer-price=\"single\"]');
  const bundle = group.querySelector('[data-offer-price=\"bundle\"]');
  const bundleCompare = group.querySelector('[data-offer-compare=\"bundle\"]');

  const parsed = parseMoney(price);
  if (single) single.textContent = price;
  if (bundle) bundle.textContent = parsed ? formatMoney(parsed, 2) : `2x ${price}`;

  const compare = findComparePriceText(scope);
  const compareParsed = parseMoney(compare);
  if (bundleCompare) {
    if (compareParsed) {
      bundleCompare.textContent = formatMoney(compareParsed, 2);
      bundleCompare.classList.add('is-visible');
    } else {
      bundleCompare.textContent = '';
      bundleCompare.classList.remove('is-visible');
    }
  }

  syncBundleBreakdown(scope, parsed, compareParsed);
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
  const subtitleConfigNode = document.querySelector('script[data-melyla-variant-subtitles]');
  const targetMainTitle = scope.querySelector('.product-details h1');
  if (!(targetMainTitle instanceof HTMLElement) || !(subtitleConfigNode instanceof HTMLScriptElement)) return;

  let subtitleConfig;
  try {
    subtitleConfig = JSON.parse(subtitleConfigNode.textContent || '{}');
  } catch (error) {
    console.error('Failed to parse variant subtitle config:', error);
    return;
  }

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
  const variantConfigNode = document.querySelector('script[data-melyla-variant-subtitles]');

  let productId = '';
  if (variantConfigNode instanceof HTMLScriptElement) {
    try {
      const config = JSON.parse(variantConfigNode.textContent || '{}');
      productId = String(config?.productId || '');
    } catch (error) {
      console.error('Failed to parse product config for reviews:', error);
    }
  }

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
    form.addEventListener('submit', () => {
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
