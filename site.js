// Gamertown Shared Site Script
const menuToggle = document.getElementById('menuToggle');
const navLists = document.querySelectorAll('.navbar-nav, .nav-links');

if (menuToggle) {
  menuToggle.addEventListener('click', () => {
    navLists.forEach(nav => {
      const current = window.getComputedStyle(nav).display;
      nav.style.display = current === 'flex' ? 'none' : 'flex';
    });
  });
}

const contactForm = document.getElementById('contactForm');
if (contactForm) {
  contactForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const formData = {
      name: document.getElementById('name')?.value,
      email: document.getElementById('email')?.value,
      message: document.getElementById('message')?.value
    };

    console.log('Form submitted:', formData);
    alert('Thank you for your inquiry! We\'ll get back to you soon.');
    contactForm.reset();
  });
}

const searchBtn = document.querySelector('.search-btn');
const searchInput = document.querySelector('.search-input');
if (searchBtn && searchInput) {
  searchBtn.addEventListener('click', () => {
    const query = searchInput.value.trim();
    if (!query) return;
    console.log('Search feature coming soon:', query);
    alert('Search feature coming soon!');
  });

  searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      searchBtn.click();
    }
  });
}

document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', function (e) {
    const href = this.getAttribute('href');
    if (href === '#' || href === '') return;
    const target = document.querySelector(href);
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: 'smooth' });
  });
});

window.addEventListener('scroll', () => {
  const header = document.querySelector('header');
  if (!header) return;
  header.style.boxShadow = window.scrollY > 20 ? '0 10px 30px rgba(0,0,0,0.25)' : 'none';
});

console.log('Gamertown shared site script loaded.');
