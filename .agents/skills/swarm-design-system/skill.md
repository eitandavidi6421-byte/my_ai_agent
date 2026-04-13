---
name: Swarm Design System & Styling
description: >
  Load this skill when creating new UI elements, sidebars, or modifying the Swarm Dashboard's
  visual appearance. Essential for maintaining the "Gemini-inspired" premium aesthetic, 
  glassmorphism effects, dark mode compatibility, and consistent use of CSS variables. 
  Follow these patterns to ensure a high-end, responsive, and accessible user interface.
---

# Swarm Design System – Styling Guide

## Core Design Principles

1. **Glassmorphism**: Use semi-transparent backgrounds with heavy backdrop blurs for headers and overlays.
2. **Premium Colors**: Avoid generic colors. Use the CSS variables defined in `:root`.
3. **Typography**: Prioritize 'Assistant' and 'Inter'. Use specific font weights (700 for headers, 400/500 for body).
4. **Micro-interactions**: Use subtle transitions (0.2s ease) and hover effects (scale, opacity).
5. **RTL Support**: The UI is designed for Hebrew/English. Use `padding-inline` and `margin-inline` where possible.

---

## Design Tokens (CSS Variables)

Always use these variables instead of hardcoded hex codes:

```css
/* Light Mode (Default) */
--bg-primary: #ffffff;
--bg-secondary: #f9fafb;
--bg-glass: rgba(255, 255, 255, 0.8);
--text-primary: #111827;
--text-secondary: #4b5563;
--accent-primary: #3b82f6;
--accent-gradient: linear-gradient(135deg, #3b82f6, #8b5cf6);
--radius-md: 12px;
--shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.1);

/* Dark Mode (Applied via [data-theme='dark']) */
--bg-primary: #0d0d0f;
--bg-secondary: #141417;
--bg-glass: rgba(13, 13, 15, 0.8);
--text-primary: #f3f4f6;
```

---

## Component Templates

### 1. The Glassmorphic Header

```html
<header class="app-header">
  <div class="logo-area">AI Swarm Pro</div>
  <div class="header-actions">
    <button class="header-btn" title="Settings">⚙️</button>
  </div>
</header>
```

```css
.app-header {
  background: var(--bg-glass);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-bottom: 1px solid var(--border-subtle);
}
```

### 2. Premium Primary Button

```html
<button class="primary-btn">Get Started</button>
```

```css
.primary-btn {
  background: var(--text-primary);
  color: var(--bg-primary);
  padding: 12px 28px;
  border-radius: var(--radius-full);
  font-weight: 600;
  transition:
    transform 0.2s ease,
    opacity 0.2s ease;
}
.primary-btn:hover {
  transform: translateY(-1px);
  opacity: 0.9;
}
```

### 3. Gemini-Style AI Message Bubble

AI messages are "unboxed" (no background) to feel like natural document content.

```css
.msg-bubble-ai {
  font-family: var(--font-base);
  line-height: 1.7;
  color: var(--text-primary);
}

.msg-bubble-ai h1 {
  font-size: 1.6rem;
  border-bottom: 2px solid var(--border-subtle);
  padding-bottom: 8px;
  margin-top: 24px;
}
```

---

## Styling Best Practices

| Do                                              | Don't                                     |
| ----------------------------------------------- | ----------------------------------------- |
| Use `backdrop-filter` for overlays              | Use solid heavy colors for sidebars       |
| Use `linear-gradient` for brand highlights      | Use standard blue links for text mentions |
| Apply `animation: slideUp 0.3s` to new messages | Let elements pop in instantly             |
| Use `var(--radius-md)` for cards                | Use sharp corners (0px radius)            |
| Ensure `focus-visible` outlines are set         | Remove focus indicators entirely          |

---

## Layout Transitions

When opening sidebars (Canvas/Project Plan), the main layout should shift smoothly.

```css
#main-layout {
  display: grid;
  grid-template-columns: 1fr;
  transition: grid-template-columns 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

#main-layout.canvas-open {
  grid-template-columns: 1fr 400px; /* Shifts chat to the left */
}
```

---

## Dark Mode Considerations

The extension uses a `[data-theme='dark']` attribute on the `body`.

- Always test your components in both modes.
- Use `rgba` with low opacity (0.05 - 0.1) for subtle dark-mode borders.
- Avoid pure black `#000`; use `var(--bg-primary)` (#0d0d0f) for a deeper, more premium feel.
