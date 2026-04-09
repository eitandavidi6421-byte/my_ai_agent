---
name: Three.js Resize Listener
description: >
  Load this skill whenever you are writing or modifying Three.js scenes and need to handle 
  responsive canvas resizing, camera aspect ratio updates, or renderer pixel ratio 
  adjustments. Also load it when the user reports a distorted, stretched, or black canvas 
  after a window resize event.
---

# Three.js Resize Listener – Skill Guide

## Overview

Three.js does **not** automatically handle window resizing. You must manually update both the **Renderer** (canvas size) and the **Camera** (aspect ratio) whenever the window or container size changes.

---

## Core implementation

```javascript
// 1. Initial Setup
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(
    75, 
    window.innerWidth / window.innerHeight, 
    0.1, 
    1000
);

// 2. The Resize Handler
function onWindowResize() {
    // Update Camera
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();

    // Update Renderer
    renderer.setSize(window.innerWidth, window.innerHeight);
    
    // (Optional) Update CSS or other dependent elements
}

// 3. Attach Listener
window.addEventListener('resize', onWindowResize, false);
```

---

## Handling Container Scenarios

If the canvas is inside a specific `div` (not full-screen), use `getBoundingClientRect()` or even better, a `ResizeObserver`.

```javascript
const container = document.getElementById('canvas-container');

// Preferred method for modern apps:
const resizeObserver = new ResizeObserver(entries => {
    for (let entry of entries) {
        const { width, height } = entry.contentRect;
        
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        
        renderer.setSize(width, height);
    }
});

resizeObserver.observe(container);
```

---

## Best Practices

1. **Avoid Distortions**: Always call `camera.updateProjectionMatrix()` after changing the aspect ratio.
2. **Device Pixel Ratio**: Set `renderer.setPixelRatio(window.devicePixelRatio)` to ensure the scene isn't blurry on high-DPI (Retina) screens.
3. **Throttling**: If your resize logic is computationally expensive, consider debouncing or throttling the event listener.
4. **Cleanup**: If using a framework like React or Vue, always `removeEventListener` or `disconnect()` the observer when the component unmounts.
5. **CSS Stretch**: Do not use CSS to handle the canvas width/height (e.g., `width: 100%`). This will only stretch the pixels, not change the resolution. Always use `renderer.setSize()`.
