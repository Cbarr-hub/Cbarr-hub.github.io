# Gamertown Solutions - Frontend Design Plan v1

## Color Scheme
- **Primary Green**: `#42F527` - Accent color for CTAs, highlights
- **Black**: `#000000` - Text, borders, backgrounds
- **Cream/Beige**: `#EDF0C5` - Light backgrounds, text contrast

## Landing Page v1 Architecture

### 1. Header/Navigation Banner
- **Fixed position** at top of page
- **Background**: Black (`#000000`)
- **Text Color**: Cream (`#EDF0C5`)
- **Components**:
  - Logo placeholder (left side) - 50px height
  - Search bar (center) - input field with green border/focus
  - Navigation items:
    - Discord link (primary CTA - green button)
    - Help/Customer Support (text link)
  - Mobile responsive (hamburger menu for tablets/mobile)

### 2. Hero Section
- **Layout**: Two-column grid (image + text)
- **Left Column**: Giant hero image placeholder (responsive)
- **Right Column**: Giant text section
  - Main headline
  - Subheading
  - CTA button (green background)
- **Background**: Cream (`#EDF0C5`)

### 3. Advertisement Spaces
- **Placement**: Left and right sidebars (desktop only)
- **Width**: ~250px each
- **Hide on tablets and mobile** (responsive design)
- **Background**: Light gray borders to denote ad spaces

### 4. Content Areas
- **Center column**: Main content area (900px max-width)
- **Typography**: Clear hierarchy with black text on cream backgrounds

### 5. Footer - Contact/Inquiry Section
- **Background**: Black (`#000000`)
- **Text**: Cream (`#EDF0C5`)
- **Components**:
  - Contact form
    - Name input
    - Email input
    - Message textarea
    - Submit button (green)
  - Footer links
  - Copyright

## Responsive Breakpoints
- **Desktop**: 1200px+ (includes sidebars for ads)
- **Tablet**: 768px - 1199px (single column, no sidebars)
- **Mobile**: < 768px (stacked, full-width)

## Design Principles
1. **High Contrast**: Black text on cream backgrounds for readability
2. **Green Accents**: Use `#42F527` for all interactive elements (buttons, links, hover states)
3. **Clean Layout**: Whitespace-focused design
4. **Accessibility**: WCAG compliant color ratios, semantic HTML
5. **Performance**: Optimized images, minimal CSS

## Next Steps
1. ✅ Create responsive HTML template
2. ✅ Create CSS stylesheet with color scheme
3. Create image assets (hero image, logo)
4. Test on multiple devices
5. Implement backend for contact form
