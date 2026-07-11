/*!
 * Yule Love Lights — embeddable website lead form (Phase 2 of #leads).
 * Vanilla JS, zero dependencies, no build step. Served statically from the
 * quote tool at https://quote.yulelovelights.com/lead-form.js and dropped
 * into WordPress (yulelovelights.com) via an Elementor HTML widget:
 *
 *   <div data-yll-lead-form="full"></div>
 *   <script src="https://quote.yulelovelights.com/lead-form.js" async></script>
 *
 * Variants: "full" | "bar" | "sticky". Optional per-container overrides:
 *   data-api-base="http://localhost:3000"   (local testing)
 *   data-service="permanent"                (pre-select + hide the picker)
 *
 * The request contract (field names, caps, honeypot, elapsedMs, consent)
 * is PINNED by src/app/api/leads/route.ts + route.test.ts in the quote
 * tool repo — this file has no test of its own on purpose (see AGENTS.md
 * task notes for #leads Phase 2); it is verified live in Phase 3. Keep the
 * field names/values below in sync with that route if it ever changes.
 *
 * All markup is built with plain DOM methods (createElement / textContent)
 * — no innerHTML anywhere, even for the static disclosure copy below.
 */
(function () {
  'use strict';

  if (window.__yllLeadFormLoaded) return;
  window.__yllLeadFormLoaded = true;

  var DEFAULT_API_BASE = 'https://quote.yulelovelights.com';
  var UTM_STORAGE_KEY = 'yll_lf_utm';
  var STICKY_DISMISS_KEY = 'yll_lf_sticky_dismissed';
  var STICKY_REVEAL_PX = 600;
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var PHONE_MIN_DIGITS = 7;
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

  var SERVICES = [
    { value: 'christmas', label: 'Christmas Lighting' },
    { value: 'permanent', label: 'Permanent Lighting' },
    { value: 'event-wedding', label: 'Event & Wedding Lighting' },
    { value: 'landscape', label: 'Landscape Lighting' },
  ];

  // photo service cards ("full" variant only) — same 400x400 files the old
  // Gravity Forms page uses, so they're already in the visitor's cache.
  var SERVICE_IMAGES = {
    christmas: 'https://yulelovelights.com/wp-content/uploads/2025/07/Holiday-Lighting-srv-pic-400x400.jpg',
    permanent: 'https://yulelovelights.com/wp-content/uploads/2025/07/Perm-Lighting-srv-pic-400x400.jpg',
    'event-wedding': 'https://yulelovelights.com/wp-content/uploads/2025/07/Event-Lights-srv-pic-400x400.jpg',
    landscape: 'https://yulelovelights.com/wp-content/uploads/2025/07/Landscape-srv-pic-400x400.jpg',
  };

  var uidCounter = 0;
  function uid(prefix) {
    uidCounter += 1;
    return prefix + '-' + uidCounter;
  }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // PostHog (guard every call — it may not exist, or fail)
  function track(event, props) {
    try {
      if (window.posthog && typeof window.posthog.capture === 'function') {
        window.posthog.capture(event, props || {});
      }
    } catch (e) {
      /* never let analytics break the form */
    }
  }

  // small DOM helper (no innerHTML — only createElement/textContent)
  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var key in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
        var val = attrs[key];
        if (val === undefined || val === null || val === false) continue;
        if (key === 'class') node.className = val;
        else if (key === 'text') node.textContent = val;
        else if (key.indexOf('on') === 0 && typeof val === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), val);
        } else {
          node.setAttribute(key, val === true ? '' : val);
        }
      }
    }
    (children || []).forEach(function (c) {
      if (c === undefined || c === null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  // validation helpers
  function isValidEmail(v) {
    return EMAIL_RE.test(v);
  }
  function phoneDigitCount(v) {
    var m = v.match(/\d/g);
    return m ? m.length : 0;
  }
  function hasTestFlag() {
    try {
      return new URLSearchParams(location.search).get('yll_test') === '1';
    } catch (e) {
      return false;
    }
  }

  // UTM first-touch capture (runs once, at script load)
  function captureUtmFirstTouch() {
    var existing;
    try {
      existing = sessionStorage.getItem(UTM_STORAGE_KEY);
    } catch (e) {
      existing = null;
    }
    if (existing) return; // first touch wins

    var params;
    try {
      params = new URLSearchParams(location.search);
    } catch (e) {
      return;
    }
    var found = {};
    var any = false;
    UTM_KEYS.forEach(function (key) {
      var v = params.get(key);
      if (v) {
        found[key] = v;
        any = true;
      }
    });
    if (!any) return;
    found.landing = location.href;
    try {
      sessionStorage.setItem(UTM_STORAGE_KEY, JSON.stringify(found));
    } catch (e) {
      /* private-mode / storage full — attribution is best-effort */
    }
  }

  function getStoredUtm() {
    try {
      var raw = sessionStorage.getItem(UTM_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function buildUtmForPayload(stored) {
    if (!stored) return undefined;
    var utm = {};
    var any = false;
    UTM_KEYS.forEach(function (key) {
      if (stored[key]) {
        utm[key] = stored[key];
        any = true;
      }
    });
    return any ? utm : undefined;
  }

  // injected styles (single <style> tag, scoped to .yll-lf-*)
  function injectStyles() {
    if (document.getElementById('yll-lf-styles')) return;
    var css = [
      '.yll-lf,.yll-lf *,.yll-lf *::before,.yll-lf *::after{box-sizing:border-box;}',
      '.yll-lf{--yll-lf-green:#1E7A42;--yll-lf-green-dark:#175f34;--yll-lf-red:#CF0303;',
      '--yll-lf-text:#1a1a1a;--yll-lf-muted:#6b6b6b;--yll-lf-border:#e0ddd8;--yll-lf-bg:#ffffff;',
      '--yll-lf-error:#CF0303;--yll-lf-radius:12px;--yll-lf-radius-pill:999px;',
      '--yll-lf-shadow:0 2px 14px rgba(0,0,0,0.10);',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen-Sans,Ubuntu,Cantarell,"Helvetica Neue",sans-serif;',
      'color:var(--yll-lf-text);line-height:1.4;text-align:left;}',
      '.yll-lf a{color:var(--yll-lf-green);}',
      '.yll-lf-visually-hidden{position:absolute!important;width:1px!important;height:1px!important;',
      'padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;',
      'white-space:nowrap!important;border:0!important;}',
      '.yll-lf--full{background:var(--yll-lf-bg);border-radius:var(--yll-lf-radius);box-shadow:var(--yll-lf-shadow);',
      'padding:24px;max-width:1140px;width:100%;}',
      '.yll-lf--bar{background:var(--yll-lf-bg);border-radius:var(--yll-lf-radius);box-shadow:var(--yll-lf-shadow);padding:20px;}',
      '.yll-lf-heading{margin:0 0 4px;font-size:22px;font-weight:700;color:var(--yll-lf-text);}',
      '.yll-lf-accent{color:var(--yll-lf-red);}',
      '.yll-lf-form{display:flex;flex-direction:column;gap:14px;}',
      '.yll-lf-field{display:flex;flex-direction:column;gap:6px;}',
      '.yll-lf-label{font-size:13px;font-weight:600;color:var(--yll-lf-text);}',
      '.yll-lf-required{color:var(--yll-lf-red);margin-left:2px;}',
      '.yll-lf-input,.yll-lf-select,.yll-lf-textarea{font:inherit;font-size:15px;color:var(--yll-lf-text);',
      'background:#fff;border:1px solid var(--yll-lf-border);border-radius:8px;padding:10px 12px;min-height:44px;width:100%;outline:none;}',
      '.yll-lf-textarea{min-height:80px;resize:vertical;}',
      '.yll-lf-input:focus-visible,.yll-lf-select:focus-visible,.yll-lf-textarea:focus-visible{border-color:var(--yll-lf-green);outline:2px solid var(--yll-lf-green);outline-offset:1px;}',
      '.yll-lf-input--error,.yll-lf-select--error{border-color:var(--yll-lf-error);}',
      '.yll-lf-field-error{font-size:12px;color:var(--yll-lf-error);min-height:14px;}',
      '.yll-lf-formerror{font-size:13px;color:var(--yll-lf-error);background:#fdecea;border-radius:8px;padding:10px 12px;}',
      '.yll-lf-cards{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;}',
      '@media(min-width:520px){.yll-lf-cards{grid-template-columns:repeat(4,1fr);}}',
      '.yll-lf-card{border:1.5px solid var(--yll-lf-border);border-radius:10px;padding:8px;min-height:44px;',
      'display:flex;flex-direction:column;align-items:stretch;gap:8px;text-align:center;font-size:13px;',
      'font-weight:600;cursor:pointer;position:relative;background:#fff;}',
      '.yll-lf-card-media{position:relative;width:100%;aspect-ratio:1/1;border-radius:8px;overflow:hidden;background:#f2f1ee;}',
      '.yll-lf-card-img{width:100%;height:100%;object-fit:cover;display:block;}',
      '.yll-lf-card:focus-visible{outline:2px solid var(--yll-lf-green);outline-offset:2px;}',
      '.yll-lf-card--selected{border-color:var(--yll-lf-red);background:rgba(207,3,3,0.06);color:var(--yll-lf-red);}',
      '.yll-lf-card-check{display:none;position:absolute;top:6px;right:6px;width:20px;height:20px;',
      'border-radius:50%;background:var(--yll-lf-red);align-items:center;justify-content:center;',
      'box-shadow:0 1px 3px rgba(0,0,0,0.35);}',
      '.yll-lf-card-check::after{content:"";width:8px;height:5px;border-left:2px solid #fff;',
      'border-bottom:2px solid #fff;transform:rotate(-45deg);margin-top:-2px;}',
      '.yll-lf-card--selected .yll-lf-card-check{display:flex;}',
      '.yll-lf-consent{display:flex;flex-direction:column;gap:6px;}',
      '.yll-lf-consent-row{display:flex;align-items:flex-start;gap:8px;}',
      '.yll-lf-consent-row input{width:20px;height:20px;min-height:20px;flex:none;margin-top:2px;accent-color:var(--yll-lf-green);}',
      '.yll-lf-consent-text{font-size:13px;color:var(--yll-lf-text);}',
      '.yll-lf-consent-disclosure{font-size:11px;color:var(--yll-lf-muted);}',
      '.yll-lf-consent-disclosure a{color:var(--yll-lf-muted);text-decoration:underline;}',
      '.yll-lf-submit{font:inherit;font-size:15px;font-weight:600;color:#fff;background:var(--yll-lf-green);',
      'border:none;border-radius:var(--yll-lf-radius-pill);padding:14px 28px;min-height:48px;cursor:pointer;}',
      '.yll-lf-submit:hover{background:var(--yll-lf-green-dark);}',
      '.yll-lf-submit:disabled{opacity:0.65;cursor:default;}',
      '.yll-lf-submit:focus-visible{outline:2px solid var(--yll-lf-green-dark);outline-offset:2px;}',
      '.yll-lf-thankyou{text-align:center;padding:12px 4px;}',
      '.yll-lf-thankyou-heading{font-size:17px;font-weight:700;margin:0 0 6px;}',
      '.yll-lf-thankyou-body{font-size:14px;color:var(--yll-lf-muted);margin:0 0 10px;}',
      '.yll-lf-thankyou-tel{font-weight:600;}',
      // "full" variant desktop layout — 2-col field grid, cards/notes/consent/
      // submit span the full width. Mobile (<768px) keeps the default
      // single-column flex form above untouched.
      '@media(min-width:768px){.yll-lf--full .yll-lf-form{display:grid;grid-template-columns:1fr 1fr;gap:24px;}',
      '.yll-lf--full .yll-lf-form>.yll-lf-heading,.yll-lf--full .yll-lf-field--service,',
      '.yll-lf--full .yll-lf-field--notes,.yll-lf--full .yll-lf-field--consent,',
      '.yll-lf--full .yll-lf-form>.yll-lf-formerror,.yll-lf--full .yll-lf-form>.yll-lf-submit{grid-column:1/-1;}',
      '.yll-lf--full .yll-lf-form>.yll-lf-submit{justify-self:center;width:auto;padding-left:48px;padding-right:48px;}}',
      // bar + sticky share the row/stack breakpoint; deltas kept separate
      '.yll-lf--bar .yll-lf-form,.yll-lf-sticky .yll-lf-form{flex-direction:column;}',
      '.yll-lf-sticky-outer{position:fixed;left:0;right:0;bottom:0;z-index:999999;',
      'transform:translateY(100%);transition:transform 0.25s ease;pointer-events:none;}',
      '.yll-lf-sticky-outer.yll-lf-sticky-visible{transform:translateY(0);pointer-events:auto;}',
      '.yll-lf-sticky{background:var(--yll-lf-bg);box-shadow:0 -2px 14px rgba(0,0,0,0.14);',
      'padding:14px 16px;max-height:40vh;overflow-y:auto;position:relative;}',
      '.yll-lf-sticky .yll-lf-form{gap:8px;}',
      '.yll-lf-sticky .yll-lf-field{gap:3px;}',
      '.yll-lf-sticky .yll-lf-input,.yll-lf-sticky .yll-lf-select{min-height:40px;padding:8px 10px;}',
      '.yll-lf-sticky .yll-lf-submit{padding:10px 20px;min-height:44px;}',
      '.yll-lf-sticky .yll-lf-consent-row input{width:16px;height:16px;min-height:16px;}',
      '.yll-lf-sticky .yll-lf-consent-text{font-size:12px;}',
      '.yll-lf-sticky-dismiss{position:absolute;top:6px;right:8px;background:transparent;border:none;',
      'font-size:18px;line-height:1;color:var(--yll-lf-muted);cursor:pointer;padding:8px;min-width:32px;min-height:32px;}',
      '.yll-lf-sticky-dismiss:focus-visible{outline:2px solid var(--yll-lf-green);outline-offset:1px;}',
      '@media(min-width:760px){.yll-lf--bar .yll-lf-form,.yll-lf-sticky .yll-lf-form{flex-direction:row;flex-wrap:wrap;align-items:flex-end;gap:10px;}',
      '.yll-lf--bar .yll-lf-field,.yll-lf-sticky .yll-lf-field{min-width:110px;}',
      '.yll-lf--bar .yll-lf-field{flex:1 1 140px;}',
      '.yll-lf-sticky .yll-lf-field{flex:1 1 130px;}',
      '.yll-lf--bar .yll-lf-field--consent{flex-basis:100%;order:5;}',
      '.yll-lf-sticky .yll-lf-field--consent{flex-basis:220px;}',
      '.yll-lf--bar .yll-lf-submit,.yll-lf-sticky .yll-lf-submit{flex:none;}',
      '.yll-lf-sticky{max-height:none;}',
      '.yll-lf-sticky .yll-lf-form{padding-right:24px;}}',
    ].join('');
    var style = document.createElement('style');
    style.id = 'yll-lf-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // consent copy — verbatim from the live Gravity Form (id=1) on
  // https://yulelovelights.com/get-a-quote/, confirmed 2026-07-11.
  var CONSENT_LABEL_TEXT =
    'I consent to receive text messages about Upcoming or Previous Projects from Yule Love Lights LLC, at the phone number I provided.';

  // Built with plain DOM nodes (never innerHTML), but renders the same
  // "...view our Terms and Privacy Policy." sentence with real links.
  function buildConsentDisclosure() {
    var wrap = h('div', { class: 'yll-lf-consent-disclosure' });
    wrap.appendChild(
      document.createTextNode(
        'I acknowledge that my consent is not a condition of purchase. Msg & data rates may apply. ' +
          'Msg frequency varies. Reply HELP for assistance or STOP to opt out of receiving messages. ' +
          'For more details, view our '
      )
    );
    wrap.appendChild(
      h('a', { href: 'https://yulelovelights.com/terms-and-conditions/', target: '_blank', rel: 'noopener noreferrer' }, ['Terms'])
    );
    wrap.appendChild(document.createTextNode(' and '));
    wrap.appendChild(
      h('a', { href: 'https://yulelovelights.com/privacy-policy/', target: '_blank', rel: 'noopener noreferrer' }, ['Privacy Policy'])
    );
    wrap.appendChild(document.createTextNode('.'));
    return wrap;
  }

  // field builders
  function buildLabel(forId, text, opts) {
    opts = opts || {};
    var children = [text];
    if (opts.required) children.push(h('span', { class: 'yll-lf-required', 'aria-hidden': 'true' }, ['*']));
    return h('label', { for: forId, class: 'yll-lf-label' + (opts.hidden ? ' yll-lf-visually-hidden' : '') }, children);
  }

  function buildTextField(opts) {
    // opts: { type, name, label, placeholder, autocomplete, hideLabel, required, textarea, maxLength }
    var id = uid('yll-lf-' + opts.name);
    var input = opts.textarea
      ? h('textarea', {
          id: id,
          class: 'yll-lf-textarea',
          name: opts.name,
          placeholder: opts.placeholder,
          rows: '3',
          maxlength: opts.maxLength,
        })
      : h('input', {
          id: id,
          class: 'yll-lf-input',
          type: opts.type || 'text',
          name: opts.name,
          placeholder: opts.placeholder,
          autocomplete: opts.autocomplete,
          maxlength: opts.maxLength,
        });
    var errorEl = h('div', { class: 'yll-lf-field-error', role: 'alert' });
    var field = h('div', { class: 'yll-lf-field yll-lf-field--' + opts.name }, [
      buildLabel(id, opts.label, { hidden: opts.hideLabel, required: opts.required }),
      input,
      errorEl,
    ]);
    return { field: field, input: input, errorEl: errorEl };
  }

  function buildServiceCards(preselected, labelledById) {
    var group = h('div', {
      class: 'yll-lf-cards',
      role: 'radiogroup',
      'aria-labelledby': labelledById,
      'aria-required': 'true',
    });
    var cardEls = [];
    var current = preselected || null;

    function paint() {
      cardEls.forEach(function (c) {
        var selected = c.getAttribute('data-value') === current;
        c.classList.toggle('yll-lf-card--selected', selected);
        c.setAttribute('aria-checked', selected ? 'true' : 'false');
        c.setAttribute('tabindex', selected || (!current && c === cardEls[0]) ? '0' : '-1');
      });
    }

    SERVICES.forEach(function (svc) {
      // the media box has a fixed aspect-ratio, so a slow/failed image load
      // (no onerror handler) never shifts the card's layout or blocks a click.
      var media = h('div', { class: 'yll-lf-card-media' }, [
        h('img', {
          class: 'yll-lf-card-img',
          src: SERVICE_IMAGES[svc.value],
          alt: svc.label,
          loading: 'lazy',
          draggable: 'false',
        }),
        h('span', { class: 'yll-lf-card-check', 'aria-hidden': 'true' }),
      ]);
      var card = h(
        'div',
        {
          class: 'yll-lf-card',
          role: 'radio',
          'aria-checked': 'false',
          tabindex: '-1',
          'data-value': svc.value,
        },
        [media, h('span', { class: 'yll-lf-card-label', text: svc.label })]
      );
      card.addEventListener('click', function () {
        current = svc.value;
        paint();
        group.dispatchEvent(new CustomEvent('yll-lf-service-change', { detail: current }));
      });
      cardEls.push(card);
      group.appendChild(card);
    });

    group.addEventListener('keydown', function (e) {
      var idx = -1;
      for (var ci = 0; ci < cardEls.length; ci++) {
        if (cardEls[ci].getAttribute('data-value') === current) {
          idx = ci;
          break;
        }
      }
      if (idx === -1) idx = 0;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        idx = (idx + 1) % cardEls.length;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        idx = (idx - 1 + cardEls.length) % cardEls.length;
      } else {
        return;
      }
      current = cardEls[idx].getAttribute('data-value');
      paint();
      cardEls[idx].focus();
      group.dispatchEvent(new CustomEvent('yll-lf-service-change', { detail: current }));
    });

    paint();
    return {
      el: group,
      getValue: function () {
        return current;
      },
    };
  }

  function buildServiceSelect(preselected, hideLabel) {
    var id = uid('yll-lf-service');
    var select = h('select', { id: id, class: 'yll-lf-select', name: 'service' });
    select.appendChild(h('option', { value: '', disabled: 'disabled', selected: 'selected' }, ['Choose a service']));
    SERVICES.forEach(function (svc) {
      var opt = h('option', { value: svc.value }, [svc.label]);
      if (svc.value === preselected) opt.selected = true;
      select.appendChild(opt);
    });
    var errorEl = h('div', { class: 'yll-lf-field-error', role: 'alert' });
    var field = h('div', { class: 'yll-lf-field yll-lf-field--service' }, [
      buildLabel(id, 'Service', { hidden: hideLabel, required: true }),
      select,
      errorEl,
    ]);
    return { field: field, select: select, errorEl: errorEl };
  }

  function buildConsent(hideDisclosure) {
    var id = uid('yll-lf-consent');
    var checkbox = h('input', { id: id, type: 'checkbox', name: 'consent' });
    var errorEl = h('div', { class: 'yll-lf-field-error', role: 'alert' });
    var innerChildren = [
      h('div', { class: 'yll-lf-consent-row' }, [
        checkbox,
        h('label', { for: id, class: 'yll-lf-consent-text' }, [CONSENT_LABEL_TEXT]),
      ]),
    ];
    if (!hideDisclosure) innerChildren.push(buildConsentDisclosure());
    var field = h('div', { class: 'yll-lf-field yll-lf-field--consent' }, [
      h('div', { class: 'yll-lf-consent' }, innerChildren),
      errorEl,
    ]);
    return { field: field, checkbox: checkbox, errorEl: errorEl };
  }

  function buildHoneypot() {
    return h('input', {
      class: 'yll-lf-visually-hidden',
      type: 'text',
      name: 'company',
      tabindex: '-1',
      // Chrome/1Password/LastPass address-autofill can fill a hidden
      // "company" field even though a real visitor never sees or types into
      // it. autocomplete="off" is WIDELY IGNORED by Chrome for
      // address-shaped fields, so we use "one-time-code" instead (a token
      // address-autofill engines don't treat as an address field) plus the
      // vendor-specific ignore hints below.
      autocomplete: 'one-time-code',
      'data-lpignore': 'true',
      'data-1p-ignore': '',
      'data-form-type': 'other',
      'aria-hidden': 'true',
    });
  }

  // validation
  // Address is never required client-side (the API doesn't require it
  // either) — on "full" it's only marked with a visual "*" so the layout
  // matches the other required-looking fields; it never blocks submit.
  function validate(values) {
    var errors = {};
    if (!values.name.trim()) errors.name = 'Please enter your name.';
    if (!values.email.trim() || !isValidEmail(values.email.trim())) {
      errors.email = 'Please enter a valid email address.';
    }
    if (!values.phone.trim() || phoneDigitCount(values.phone) < PHONE_MIN_DIGITS) {
      errors.phone = 'Please enter a valid phone number.';
    }
    if (!values.service) errors.service = 'Please choose a service.';
    if (!values.consent) errors.consent = 'Please check the box to continue.';
    return errors;
  }

  // the shared form builder
  // config: { variant, apiBase, heading (Node|null), submitLabel,
  //           hideLabels, showAddress, addressRequired (visual only),
  //           showNotes, serviceControl: 'cards'|'select', preselectService,
  //           hidePicker, compactConsent }
  function buildForm(config) {
    var renderedAt = Date.now();
    var startedTracked = false;

    var nameF = buildTextField({
      type: 'text',
      name: 'name',
      label: 'Name',
      placeholder: 'Your name',
      autocomplete: 'name',
      hideLabel: config.hideLabels,
      required: true,
      maxLength: 200,
    });
    var emailF = buildTextField({
      type: 'email',
      name: 'email',
      label: 'Email',
      placeholder: 'you@email.com',
      autocomplete: 'email',
      hideLabel: config.hideLabels,
      required: true,
      maxLength: 320,
    });
    var phoneF = buildTextField({
      type: 'tel',
      name: 'phone',
      label: 'Phone',
      placeholder: '(555) 555-5555',
      autocomplete: 'tel',
      hideLabel: config.hideLabels,
      required: true,
      maxLength: 40,
    });
    var addressF = config.showAddress
      ? buildTextField({
          type: 'text',
          name: 'address',
          label: 'Address',
          placeholder: 'Street address',
          autocomplete: 'street-address',
          hideLabel: config.hideLabels,
          required: config.addressRequired, // visual only — see validate()
          maxLength: 500,
        })
      : null;
    var notesF = config.showNotes
      ? buildTextField({
          name: 'notes',
          label: 'Notes (optional)',
          placeholder: 'Tell us about your project',
          hideLabel: config.hideLabels,
          textarea: true,
          maxLength: 5000,
        })
      : null;

    var serviceCards = null;
    var serviceSelect = null;
    var serviceField = null;
    if (!config.hidePicker) {
      if (config.serviceControl === 'cards') {
        var cardsLabelId = uid('yll-lf-service-label');
        var cardsLabel = h('span', { id: cardsLabelId, class: 'yll-lf-label' }, [
          'Which service? ',
          h('span', { class: 'yll-lf-required', 'aria-hidden': 'true' }, ['*']),
        ]);
        serviceCards = buildServiceCards(config.preselectService, cardsLabelId);
        var svcErrorEl = h('div', { class: 'yll-lf-field-error', role: 'alert' });
        serviceField = h('div', { class: 'yll-lf-field yll-lf-field--service' }, [cardsLabel, serviceCards.el, svcErrorEl]);
        serviceField.errorEl = svcErrorEl;
      } else {
        serviceSelect = buildServiceSelect(config.preselectService, config.hideLabels);
        serviceField = serviceSelect.field;
        serviceField.errorEl = serviceSelect.errorEl;
      }
    }

    var consentF = buildConsent(config.compactConsent);
    var honeypot = buildHoneypot();
    // role="alert" already implies an assertive live region — an explicit
    // aria-live here is redundant (and was conflicting: "polite" vs the
    // implicit "assertive" from the role).
    var formErrorEl = h('div', { class: 'yll-lf-formerror', role: 'alert' });
    formErrorEl.style.display = 'none';

    var submitBtn = h('button', { type: 'submit', class: 'yll-lf-submit' }, [config.submitLabel]);

    var formChildren = [];
    if (config.heading) formChildren.push(config.heading);
    formChildren.push(nameF.field, emailF.field, phoneF.field);
    if (addressF) formChildren.push(addressF.field);
    if (serviceField) formChildren.push(serviceField);
    if (notesF) formChildren.push(notesF.field);
    formChildren.push(consentF.field, honeypot, formErrorEl, submitBtn);

    var form = h('form', { novalidate: true, class: 'yll-lf-form' }, formChildren);
    var root = h('div', { class: 'yll-lf yll-lf--' + config.variant });
    root.appendChild(form);

    function values() {
      return {
        name: nameF.input.value,
        email: emailF.input.value,
        phone: phoneF.input.value,
        address: addressF ? addressF.input.value : '',
        notes: notesF ? notesF.input.value : '',
        service: config.hidePicker
          ? config.preselectService
          : serviceCards
            ? serviceCards.getValue()
            : serviceSelect.select.value,
        consent: consentF.checkbox.checked,
      };
    }

    function clearErrors() {
      [nameF, emailF, phoneF, addressF].forEach(function (f) {
        if (!f) return;
        f.input.classList.remove('yll-lf-input--error');
        f.errorEl.textContent = '';
      });
      if (serviceField) {
        if (serviceSelect) serviceSelect.select.classList.remove('yll-lf-select--error');
        serviceField.errorEl.textContent = '';
      }
      consentF.errorEl.textContent = '';
      formErrorEl.style.display = 'none';
      formErrorEl.textContent = '';
    }

    function showErrors(errors) {
      var firstInvalid = null;
      var map = { name: nameF, email: emailF, phone: phoneF };
      Object.keys(map).forEach(function (key) {
        if (errors[key]) {
          map[key].input.classList.add('yll-lf-input--error');
          map[key].errorEl.textContent = errors[key];
          if (!firstInvalid) firstInvalid = map[key].input;
        }
      });
      if (errors.service && serviceField) {
        serviceField.errorEl.textContent = errors.service;
        if (serviceSelect) serviceSelect.select.classList.add('yll-lf-select--error');
        if (!firstInvalid) firstInvalid = serviceSelect ? serviceSelect.select : serviceCards.el;
      }
      if (errors.consent) {
        consentF.errorEl.textContent = errors.consent;
        if (!firstInvalid) firstInvalid = consentF.checkbox;
      }
      if (firstInvalid && firstInvalid.focus) firstInvalid.focus();
    }

    function showFormError(message) {
      formErrorEl.textContent = message;
      formErrorEl.style.display = 'block';
    }

    var submitting = false;
    function setSubmitting(isSubmitting) {
      submitting = isSubmitting;
      submitBtn.disabled = isSubmitting;
      submitBtn.textContent = isSubmitting ? 'Sending...' : config.submitLabel;
    }

    function showThankYou() {
      clearChildren(form);
      form.appendChild(
        h('div', { class: 'yll-lf-thankyou' }, [
          h('div', { class: 'yll-lf-thankyou-heading', text: 'Thanks! Your request is in.' }),
          h('p', { class: 'yll-lf-thankyou-body' }, ["We'll call or text you within one business day."]),
          h('p', { class: 'yll-lf-thankyou-body' }, [
            'Questions now? Call ',
            h('a', { href: 'tel:+16315170186', class: 'yll-lf-thankyou-tel' }, ['631-517-0186']),
          ]),
        ])
      );
    }

    // "started" — first focus on any real field, fired once
    form.addEventListener(
      'focusin',
      function (e) {
        if (startedTracked || e.target === honeypot) return;
        startedTracked = true;
        track('yll_lead_form_started', { variant: config.variant });
      },
      true
    );

    // clear a field's error as soon as the visitor edits it
    [nameF, emailF, phoneF].forEach(function (f) {
      f.input.addEventListener('input', function () {
        f.input.classList.remove('yll-lf-input--error');
        f.errorEl.textContent = '';
      });
    });
    if (serviceCards) {
      serviceCards.el.addEventListener('yll-lf-service-change', function () {
        if (serviceField) serviceField.errorEl.textContent = '';
      });
    }
    if (serviceSelect) {
      serviceSelect.select.addEventListener('change', function () {
        serviceSelect.select.classList.remove('yll-lf-select--error');
        serviceField.errorEl.textContent = '';
      });
    }
    consentF.checkbox.addEventListener('change', function () {
      consentF.errorEl.textContent = '';
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (submitting) return; // guard against a double/rapid-repeat submit
      clearErrors();
      var v = values();
      var errors = validate(v);
      if (Object.keys(errors).length) {
        showErrors(errors);
        track('yll_lead_form_error', { variant: config.variant, kind: 'validation' });
        return;
      }

      if (typeof fetch !== 'function') {
        showFormError('Something went wrong - please call 631-517-0186.');
        track('yll_lead_form_error', { variant: config.variant, kind: 'network' });
        return;
      }

      setSubmitting(true);
      var storedUtm = getStoredUtm();
      var payload = {
        name: v.name.trim(),
        email: v.email.trim(),
        phone: v.phone.trim(),
        address: v.address.trim() || undefined,
        notes: v.notes.trim() || undefined,
        service: v.service,
        consent: true,
        formVariant: config.variant,
        company: honeypot.value || '',
        elapsedMs: Date.now() - renderedAt,
        utm: buildUtmForPayload(storedUtm),
        // Truncate to the server's cap (route.ts MAX_LEN.landingUrl) — this
        // field is auto-populated, never user-typed, and must never fail to
        // submit because of its own length.
        landingUrl: ((storedUtm && storedUtm.landing) || location.href).slice(0, 1000),
        isTest: hasTestFlag(),
      };

      fetch(config.apiBase + '/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (res) {
          return res
            .json()
            .catch(function () {
              return {};
            })
            .then(function (data) {
              return { status: res.status, data: data };
            });
        })
        .then(function (result) {
          setSubmitting(false);
          if (result.status >= 200 && result.status < 300 && result.data && result.data.ok) {
            track('yll_lead_form_submitted', { variant: config.variant, service: v.service });
            showThankYou();
          } else {
            // Only surface the server's own message for a client error
            // (<500, e.g. validation/rate-limit) — a 5xx message can be an
            // internal detail ("Supabase service role not configured") that
            // a customer must never read.
            var msg =
              result.status < 500 && result.data && result.data.error
                ? result.data.error
                : 'Something went wrong - please call 631-517-0186.';
            showFormError(msg);
            track('yll_lead_form_error', { variant: config.variant, kind: 'server' });
          }
        })
        .catch(function () {
          setSubmitting(false);
          showFormError('Something went wrong - please call 631-517-0186.');
          track('yll_lead_form_error', { variant: config.variant, kind: 'network' });
        });
    });

    return { root: root, form: form };
  }

  // "viewed" tracking — fires once the form actually scrolls into view
  function trackViewedOnce(rootEl, variant) {
    var fired = false;
    function fire() {
      if (fired) return;
      fired = true;
      track('yll_lead_form_viewed', { variant: variant });
    }
    if (typeof IntersectionObserver === 'function') {
      var io = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              fire();
              io.disconnect();
            }
          });
        },
        { threshold: 0.25 }
      );
      io.observe(rootEl);
    } else {
      fire();
    }
  }

  function resolvePreselect(container) {
    var raw = container.getAttribute('data-service');
    if (!raw) return { value: null, hide: false };
    var match = SERVICES.some(function (s) {
      return s.value === raw;
    });
    if (!match) {
      console.warn('[yll-lead-form] unknown data-service "' + raw + '", ignoring — showing the picker.');
      return { value: null, hide: false };
    }
    return { value: raw, hide: true };
  }

  function resolveApiBase(container) {
    return container.getAttribute('data-api-base') || DEFAULT_API_BASE;
  }

  // variant: full
  function renderFull(container) {
    var pre = resolvePreselect(container);
    var built = buildForm({
      variant: 'full',
      apiBase: resolveApiBase(container),
      heading: h('h2', { class: 'yll-lf-heading', text: 'Get A Free Quote Today!' }),
      submitLabel: "LET'S MAKE YOUR SEASON BRIGHT!",
      hideLabels: false,
      showAddress: true,
      addressRequired: true, // visual "*" only, see validate()
      showNotes: true,
      serviceControl: 'cards',
      preselectService: pre.value,
      hidePicker: pre.hide,
      compactConsent: false,
    });
    clearChildren(container);
    container.appendChild(built.root);
    trackViewedOnce(built.root, 'full');
  }

  // variant: bar
  function renderBar(container) {
    var pre = resolvePreselect(container);
    var heading = h('h2', { class: 'yll-lf-heading' }, [
      'Get A Fast Quote - ',
      h('span', { class: 'yll-lf-accent' }, ['Takes Only 5 Seconds']),
    ]);
    var built = buildForm({
      variant: 'bar',
      apiBase: resolveApiBase(container),
      heading: heading,
      submitLabel: 'Get My Fast Quote',
      hideLabels: true,
      showAddress: true,
      addressRequired: false,
      showNotes: false,
      serviceControl: 'select',
      preselectService: pre.value,
      hidePicker: pre.hide,
      compactConsent: false,
    });
    clearChildren(container);
    container.appendChild(built.root);
    trackViewedOnce(built.root, 'bar');
  }

  // variant: sticky — appended to <body> (not the container) so an
  // Elementor ancestor with a CSS transform can't break position:fixed.
  function renderSticky(container) {
    var pre = resolvePreselect(container);
    container.style.display = 'none'; // the container is just the placement marker

    var dismissed;
    try {
      dismissed = sessionStorage.getItem(STICKY_DISMISS_KEY) === '1';
    } catch (e) {
      dismissed = false;
    }
    if (dismissed) return;

    var built = buildForm({
      variant: 'sticky',
      apiBase: resolveApiBase(container),
      heading: null,
      submitLabel: 'Get Quote',
      hideLabels: true,
      showAddress: false,
      addressRequired: false,
      showNotes: false,
      serviceControl: 'select',
      preselectService: pre.value,
      hidePicker: pre.hide,
      compactConsent: true,
    });

    // reorder fields the way the compact sticky bar expects: name, phone,
    // email, service... (buildForm's default order is name, email, phone).
    var nameField = built.form.querySelector('.yll-lf-field--name');
    var phoneField = built.form.querySelector('.yll-lf-field--phone');
    var emailField = built.form.querySelector('.yll-lf-field--email');
    if (nameField && phoneField && emailField) built.form.insertBefore(phoneField, emailField);

    var dismissBtn = h('button', { type: 'button', class: 'yll-lf-sticky-dismiss', 'aria-label': 'Dismiss', text: '×' });
    dismissBtn.addEventListener('click', function () {
      outer.classList.remove('yll-lf-sticky-visible');
      try {
        sessionStorage.setItem(STICKY_DISMISS_KEY, '1');
      } catch (e) {
        /* ignore */
      }
    });

    var inner = h('div', { class: 'yll-lf-sticky' }, [dismissBtn, built.root]);
    var outer = h('div', { class: 'yll-lf-sticky-outer' }, [inner]);
    document.body.appendChild(outer);

    trackViewedOnce(outer, 'sticky');

    var revealed = false;
    function onScroll() {
      if (revealed) return;
      if (window.scrollY > STICKY_REVEAL_PX) {
        revealed = true;
        outer.classList.add('yll-lf-sticky-visible');
        window.removeEventListener('scroll', onScroll);
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll(); // in case the page loads already scrolled
  }

  // init
  function init() {
    injectStyles();
    captureUtmFirstTouch();
    var containers = document.querySelectorAll('[data-yll-lead-form]');
    for (var i = 0; i < containers.length; i++) {
      var container = containers[i];
      var variant = container.getAttribute('data-yll-lead-form');
      if (variant === 'bar') renderBar(container);
      else if (variant === 'sticky') renderSticky(container);
      else renderFull(container); // default / unknown -> full
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
