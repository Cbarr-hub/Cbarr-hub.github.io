/* ===================================
   GAMERTOWN SOLUTIONS - SCRIPT
   =================================== */

// Mobile Menu Toggle
const menuToggle = document.getElementById('menuToggle');
const navBar = document.querySelector('.navbar-nav');

if (menuToggle) {
    menuToggle.addEventListener('click', () => {
        navBar.style.display = navBar.style.display === 'flex' ? 'none' : 'flex';
    });

    // Close menu when a link is clicked
    const navLinks = navBar.querySelectorAll('a');
    navLinks.forEach(link => {
        link.addEventListener('click', () => {
            navBar.style.display = 'none';
        });
    });
}

// Contact Form Handling
const contactForm = document.getElementById('contactForm');

if (contactForm) {
    contactForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const formData = {
            name: document.getElementById('name').value,
            email: document.getElementById('email').value,
            message: document.getElementById('message').value
        };

        // Log form data (replace with actual backend API call)
        console.log('Form submitted:', formData);

        // Show success message
        alert('Thank you for your inquiry! We\'ll get back to you soon.');

        // Reset form
        contactForm.reset();
    });
}

// Search Functionality
const searchBtn = document.querySelector('.search-btn');
const searchInput = document.querySelector('.search-input');

if (searchBtn) {
    searchBtn.addEventListener('click', () => {
        const searchQuery = searchInput.value;
        if (searchQuery.trim()) {
            console.log('Searching for:', searchQuery);
            // Implement search functionality here
            alert('Search feature coming soon!');
        }
    });

    // Allow Enter key to trigger search
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            searchBtn.click();
        }
    });
}

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        const href = this.getAttribute('href');
        if (href !== '#' && document.querySelector(href)) {
            e.preventDefault();
            const target = document.querySelector(href);
            target.scrollIntoView({
                behavior: 'smooth'
            });
        }
    });
});

// Add scroll effect to navbar
window.addEventListener('scroll', () => {
    const navbar = document.querySelector('.navbar');
    if (window.scrollY > 50) {
        navbar.style.boxShadow = 'none';
        navbar.style.borderBottomWidth = '4px';
    } else {
        navbar.style.boxShadow = 'none';
        navbar.style.borderBottomWidth = '4px';
    }
});

console.log('Gamertown Solutions - Frontend loaded successfully!');
