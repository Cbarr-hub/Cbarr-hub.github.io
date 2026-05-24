// Random distorted ad image generator
(() => {
  // Collection of free image APIs and services that work well
  const imageUrls = [
    // Picsum Photos (Lorem Picsum - random images)
    () => `https://picsum.photos/${Math.floor(Math.random() * 800 + 200)}/${Math.floor(Math.random() * 600 + 150)}?random=${Math.random()}`,
    // Unsplash API
    () => `https://source.unsplash.com/random/${Math.floor(Math.random() * 800 + 200)}x${Math.floor(Math.random() * 600 + 150)}?sig=${Math.random()}`,
    // Placeholder image with random theme
    () => {
      const themes = ['abstract', 'nature', 'technology', 'geometric', 'digital', 'fractal', 'random'];
      const theme = themes[Math.floor(Math.random() * themes.length)];
      return `https://picsum.photos/seed/${theme}${Math.random()}/${Math.floor(Math.random() * 800 + 200)}/${Math.floor(Math.random() * 600 + 150)}`;
    },
    // DiceBear avatars (pseudo-random)
    () => `https://api.dicebear.com/7.x/pixel-art/svg?seed=${Math.random()}&scale=${Math.floor(Math.random() * 30 + 70)}`,
    // Placeholder service
    () => `https://placehold.co/${Math.floor(Math.random() * 800 + 200)}x${Math.floor(Math.random() * 600 + 150)}/1a1a1a/42F527?text=SIGNAL`,
  ];

  // Distortion filters
  const filters = [
    () => `hue-rotate(${Math.floor(Math.random() * 360)}deg) saturate(${(Math.random() * 2 + 0.5).toFixed(2)}) contrast(${(Math.random() * 1.5 + 0.8).toFixed(2)})`,
    () => `grayscale(${Math.random().toFixed(2)}) contrast(${(Math.random() * 1.3 + 1).toFixed(2)}) brightness(${(Math.random() * 0.5 + 0.8).toFixed(2)})`,
    () => `sepia(${Math.random().toFixed(2)}) saturate(${(Math.random() * 2 + 1).toFixed(2)}) hue-rotate(${Math.floor(Math.random() * 60 - 30)}deg)`,
    () => `invert(${Math.random().toFixed(2)}) hue-rotate(${Math.floor(Math.random() * 360)}deg)`,
    () => `blur(${(Math.random() * 2 + 0.5).toFixed(1)}px) brightness(${(Math.random() * 0.5 + 0.8).toFixed(2)}) contrast(${(Math.random() * 1.2 + 1).toFixed(2)})`,
    () => `contrast(${(Math.random() * 1.5 + 1.2).toFixed(2)}) brightness(${(Math.random() * 0.4 + 0.8).toFixed(2)}) saturate(${(Math.random() * 1.5 + 0.5).toFixed(2)})`,
    () => `saturate(${(Math.random() * 2).toFixed(2)}) brightness(${(Math.random() * 0.6 + 0.7).toFixed(2)}) hue-rotate(${Math.floor(Math.random() * 360)}deg)`,
    () => `opacity(${(Math.random() * 0.4 + 0.6).toFixed(2)}) contrast(${(Math.random() * 1.4 + 1.1).toFixed(2)})`,
    () => `drop-shadow(${Math.floor(Math.random() * 8 - 4)}px ${Math.floor(Math.random() * 8 - 4)}px ${Math.floor(Math.random() * 12 + 8)}px rgba(66, 245, 39, ${(Math.random() * 0.3 + 0.1).toFixed(2)})) saturate(${(Math.random() * 1.5 + 0.8).toFixed(2)})`,
    () => `filter(brightness(${(Math.random() * 0.6 + 0.7).toFixed(2)})) contrast(${(Math.random() * 1.3 + 1).toFixed(2)}) sepia(${(Math.random() * 0.5).toFixed(2)})`,
  ];

  const blendModes = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'hard-light', 'difference'];

  const getRandomImage = () => {
    const urlFunc = imageUrls[Math.floor(Math.random() * imageUrls.length)];
    return urlFunc();
  };

  const getRandomFilter = () => {
    const filterFunc = filters[Math.floor(Math.random() * filters.length)];
    return filterFunc();
  };

  const getRandomBlendMode = () => {
    return blendModes[Math.floor(Math.random() * blendModes.length)];
  };

  const fillAdBlocks = () => {
    const adBlocks = document.querySelectorAll('.ad-block');
    adBlocks.forEach(block => {
      // Remove existing image if any
      const existingImg = block.querySelector('img');
      if (existingImg) existingImg.remove();

      const img = document.createElement('img');
      img.src = getRandomImage();
      img.alt = 'Esoteric Signal';
      img.style.filter = getRandomFilter();
      img.style.mixBlendMode = getRandomBlendMode();

      // Handle loading errors gracefully
      img.onerror = () => {
        img.src = `https://placehold.co/400x300/1a1a1a/42F527?text=SIGNAL`;
      };

      block.appendChild(img);
    });
  };

  // Fill on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fillAdBlocks);
  } else {
    fillAdBlocks();
  }

  // Make it globally accessible for manual refresh
  window.refreshAdBlocks = fillAdBlocks;
})();
