
# 📈 SmartProfitBinary - Crypto & Binary Trading Platform

![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white)
![Bootstrap](https://img.shields.io/badge/Bootstrap-5.3.0-7952B3?style=for-the-badge&logo=bootstrap&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES6-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![Font Awesome](https://img.shields.io/badge/Font%20Awesome-6.0.0-528DD7?style=for-the-badge&logo=fontawesome&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)

> **A complete, production-ready cryptocurrency and binary trading frontend with 13+ pages – built with Bootstrap 5, Glassmorphism design, and pure JavaScript**

---

## 🌟 Live Demo

> *[Add your GitHub Pages or Netlify link here when deployed]*

---

## 📌 About The Project

**SmartProfitBinary** is a fully-featured frontend for a cryptocurrency and binary options trading platform. It provides a realistic and professional user experience with modern **Glassmorphism design**, responsive layout, and complete user journey flows with separate public landing and authenticated dashboard areas.

### 🎯 Key Pages Included

| Page | File | Description | Access |
|------|------|-------------|--------|
| 🏠 **Landing Page** | `index.html` | High-converting public landing page | Public |
| 📊 **Dashboard** | `dashboard.html` | Main trading dashboard with market overview | Authenticated |
| ⚡ **Trade** | `trade.html` | Trading interface with charts & order book | Authenticated |
| 👤 **Profile** | `profile.html` | User profile & security management | Authenticated |
| 🔐 **Login** | `login.html` | Sign in page with auth session handler | Public |
| 📝 **Register** | `register.html` | Create new trading account | Public |
| 🔑 **Forgot Password** | `forgot-password.html` | Password recovery flow | Public |
| 📖 **Blog** | `blog.html` | Market analysis & news | Public |
| ✏️ **Blog Single** | `blog-single.html` | Individual article page | Public |
| ❓ **FAQ** | `faq.html` | Frequently asked questions | Public |
| 📞 **Contact** | `contact.html` | Support & contact form | Public |
| ⚠️ **404** | `404.html` | Custom error page | Public |

---

## ✨ Features

- 🎨 **Glassmorphism Design** – Modern, semi-transparent UI with backdrop blur
- 📱 **Fully Responsive** – Works seamlessly on desktop, tablet, and mobile
- 🔄 **Multi-Page Architecture** – Complete user flow from landing to trading
- 📊 **Trading Interface** – Dedicated trade page with chart support
- 👤 **User Authentication Flow** – Login, register, and password recovery pages
- 📝 **Blog System** – Blog listing and single post pages
- 🎯 **Font Awesome Icons** – Professional icon set throughout
- 🎨 **Custom CSS Modules** – Separate, organized stylesheets per page
- ⚡ **Vanilla JavaScript** – No heavy frameworks, fast and lightweight

---

## 🛠️ Tech Stack

| Technology | Usage |
|------------|-------|
| **HTML5** | Semantic page structure |
| **CSS3** | Custom styling & Glassmorphism effects |
| **Bootstrap 5** | Responsive grid & components |
| **Font Awesome 6** | Icons & visual elements |
| **JavaScript (ES6)** | Interactivity & dynamic content |
| **Chart.js** | Trading charts (in trade page) |

---

## 📁 Project Structure

```
ryptocurrency-exchange-dashboard/
│
├── 📁 assets/
│   ├── 📁 css/
│   │   ├── about.css
│   │   ├── auth.css
│   │   ├── blog.css
│   │   ├── blog-single.css
│   │   ├── contact.css
│   │   ├── faq.css
│   │   ├── glassmorphism.css    # Main glass effect styles
│   │   ├── login.css
│   │   ├── profile.css
│   │   ├── register.css
│   │   ├── style.css             # Global styles
│   │   ├── trade.css
│   │   └── typography.css        # Custom fonts & text
│   │
│   ├── 📁 img/
│   │   ├── index.png
│   │   ├── about.png
│   │   ├── trade.png
│   │   ├── login.png
│   │   ├── register.png
│   │   ├── profile.png
│   │   ├── forgot-password.png
│   │   ├── blog.png
│   │   ├── blog-single.png
│   │   ├── faq.png
│   │   └── contact.png
│   │
│   └── 📁 js/
│       ├── main.js               # Global scripts
│       ├── index.js
│       ├── about.js
│       ├── trade.js
│       ├── charts.js             # Chart configurations
│       ├── auth.js
│       ├── login.js
│       ├── register.js
│       ├── profile.js
│       ├── blog.js
│       ├── blog-single.js
│       ├── faq.js
│       └── contact.js
│
├── 📁 pages/
│   ├── index.html                # 🏠 Homepage
│   ├── about.html                # ℹ️ About page
│   ├── trade.html                # 📊 Trading interface
│   ├── login.html                # 🔐 Login
│   ├── register.html             # 📝 Register
│   ├── forgot-password.html      # 🔑 Password recovery
│   ├── profile.html              # 👤 User profile
│   ├── blog.html                 # 📖 Blog listing
│   ├── blog-single.html          # ✏️ Single blog post
│   ├── faq.html                  # ❓ FAQ page
│   ├── contact.html              # 📞 Contact us
│   └── 404.html                  # ⚠️ Error page
│
├── 📁 webfonts/                  # Font Awesome fonts
├── .gitattributes
├── LICENSE
└── README.md
```

---

## 🚀 Getting Started

### Prerequisites

- Any modern web browser (Chrome, Firefox, Safari, Edge)
- Local server (optional – you can open files directly, but a local server is recommended)
- **Recommended:** VS Code with Live Server extension

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/miladrezanezhad/ryptocurrency-exchange-dashboard.git
   ```

2. **Navigate to project folder**
   ```bash
   cd ryptocurrency-exchange-dashboard
   ```

3. **Open with Live Server**
   - Using VS Code: Right-click `pages/index.html` → Open with Live Server
   - Or run: `npx live-server pages/`
   - Or simply open `pages/index.html` in your browser

> ⚠️ **Note:** Some pages may need to be served from a local server for proper asset loading.

---

## 🎨 Design Highlights

### Glassmorphism Effect
The project features a modern **Glassmorphism design** (`glassmorphism.css`) with:
- Semi-transparent backgrounds
- Backdrop blur effects
- Soft shadows and borders
- Frosted glass appearance

### Custom Typography
Dedicated `typography.css` for custom font styling and text treatments.

### Responsive Breakpoints

| Breakpoint | Screen Size | Layout |
|------------|-------------|--------|
| Mobile | < 768px | Single column |
| Tablet | 768px - 1024px | Two columns |
| Desktop | > 1024px | Multi-column layout |

---

## 📸 Screenshots

| Page | Preview |
|------|---------|
| 🏠 Home | `assets/img/index.png` |
| ℹ️ About | `assets/img/about.png` |
| 📊 Trade | `assets/img/trade.png` |
| 🔐 Login | `assets/img/login.png` |
| 📝 Register | `assets/img/register.png` |
| 👤 Profile | `assets/img/profile.png` |
| 🔑 Forgot Password | `assets/img/forgot-password.png` |
| 📖 Blog | `assets/img/blog.png` |
| ✏️ Blog Single | `assets/img/blog-single.png` |
| ❓ FAQ | `assets/img/faq.png` |
| 📞 Contact | `assets/img/contact.png` |

---

## 🤝 Contributing

Contributions are welcome! Here's how:

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

### Suggestions for Improvement
- [ ] Connect to real crypto API (CoinGecko, Binance)
- [ ] Add dark/light mode toggle
- [ ] Implement form validation
- [ ] Add search functionality for blog
- [ ] Create admin panel

---

## 📄 License

This project is licensed under the **MIT License** – see the [LICENSE](LICENSE) file for details.

---

## 👤 Author

**Milad Rezanezhad**

- GitHub: [@miladrezanezhad](https://github.com/miladrezanezhad)

---

## 🙏 Acknowledgements

- [Bootstrap](https://getbootstrap.com) – UI framework
- [Font Awesome](https://fontawesome.com) – Icons
- [Chart.js](https://www.chartjs.org) – Charts library
- [Google Fonts](https://fonts.google.com) – Typography

---

## 📧 Contact

For questions or feedback, please open an issue on GitHub.

---

<div align="center">

**⭐ If you found this project helpful, please give it a star! ⭐**

Made with ❤️ and ☕ by Milad

</div>
```

