// server.js - Backend principal pour l'automatisation Hormur
const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const sharp = require('sharp');
const axios = require('axios');
const Queue = require('bull');
const path = require('path');
const cors = require('cors');

// Configuration Puppeteer avec Stealth plugin pour éviter la détection
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuration des queues Redis pour chaque plateforme
const eventimQueue = new Queue('eventim', process.env.REDIS_URL || 'redis://localhost:6379');
const jdsQueue = new Queue('jds', process.env.REDIS_URL || 'redis://localhost:6379');
const alleventsQueue = new Queue('allevents', process.env.REDIS_URL || 'redis://localhost:6379');

// Configuration des identifiants
const CREDENTIALS = {
    eventim: {
        email: 'martin.jeudy@hormur.com',
        password: 'fXjP36mb5uRnvE!'
    },
    jds: {
        email: 'contact@hormur.com',
        password: 'xl2DQ3@T2*HYex'
    },
    allevents: {
        email: 'martin.jeudy@hormur.com',
        password: 'hBH42F2.cnBjm.'
    }
};

// Fonction utilitaire pour convertir et redimensionner les images
async function processImage(imageUrl) {
    try {
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);
        
        // Convertir en carré 800x800 pour Eventim
        const squareBuffer = await sharp(buffer)
            .resize(800, 800, {
                fit: 'cover',
                position: 'centre'
            })
            .jpeg({ quality: 90 })
            .toBuffer();
            
        return squareBuffer;
    } catch (error) {
        console.error('Erreur traitement image:', error);
        return null;
    }
}

// Fonction de publication sur Eventim Light
async function publishToEventimLight(eventData) {
    const browser = await puppeteer.launch({
        headless: process.env.NODE_ENV === 'production',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process'
        ]
    });

    try {
        const page = await browser.newPage();
        
        // Configuration du viewport et user agent
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // 1. Connexion
        console.log('Connexion à Eventim Light...');
        await page.goto('https://www.eventim-light.com/fr/login', { waitUntil: 'networkidle2' });
        
        // Accepter les cookies si nécessaire
        try {
            await page.click('[data-testid="cookie-accept-all"]', { timeout: 3000 });
        } catch (e) {
            // Les cookies ont peut-être déjà été acceptés
        }
        
        // Remplir le formulaire de connexion
        await page.type('input[type="email"]', CREDENTIALS.eventim.email);
        await page.type('input[type="password"]', CREDENTIALS.eventim.password);
        await page.click('button[type="submit"]');
        
        // Attendre la redirection après connexion
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
        
        // 2. Créer un nouvel événement
        console.log('Création de l\'événement...');
        await page.goto('https://www.eventim-light.com/fr/evenements/nouveau', { waitUntil: 'networkidle2' });
        
        // Remplir les informations de base
        await page.type('input[name="eventName"]', eventData.title);
        
        // Sélectionner le genre (Concerts & Festivals > Festivals)
        await page.click('select[name="genre"]');
        await page.select('select[name="genre"]', 'Concerts & Festivals');
        await page.waitForTimeout(500);
        await page.click('select[name="subgenre"]');
        await page.select('select[name="subgenre"]', 'Festivals');
        
        // Date et heure
        const eventDate = new Date(eventData.date);
        await page.click('input[name="eventDate"]');
        
        // Navigation dans le calendrier
        await page.evaluate((year, month, day) => {
            const dateInput = document.querySelector('input[name="eventDate"]');
            dateInput.value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            dateInput.dispatchEvent(new Event('change', { bubbles: true }));
        }, eventDate.getFullYear(), eventDate.getMonth() + 1, eventDate.getDate());
        
        await page.type('input[name="eventTime"]', eventData.time || '20:00');
        
        // Lieu
        await page.type('input[name="venueName"]', eventData.venue);
        await page.type('input[name="address"]', eventData.address);
        
        // Prix - Gratuit avec mention Hormur
        await page.click('input[value="free"]');
        
        // Description avec structure Hormur
        const description = `
${eventData.description}

🎭 BILLETTERIE OFFICIELLE : HORMUR.COM 🎭
⚠️ Les réservations faites ici sont des PRÉ-RÉSERVATIONS uniquement.
✅ Pour obtenir vos billets valables, rendez-vous sur : ${eventData.eventUrl}

📍 LIEU ATYPIQUE
Cet événement se déroule dans un lieu non conventionnel.
L'adresse exacte sera communiquée après réservation sur Hormur.com

🎟️ COMMENT PARTICIPER ?
1. Pré-réservez ici gratuitement
2. Finalisez votre réservation sur Hormur.com
3. Recevez l'adresse exacte par email

💡 Hormur - La plateforme qui connecte artistes et lieux atypiques
        `.trim();
        
        await page.type('textarea[name="description"]', description);
        
        // Upload de l'image
        if (eventData.imageUrl) {
            console.log('Traitement de l\'image...');
            const imageBuffer = await processImage(eventData.imageUrl);
            
            if (imageBuffer) {
                // Créer un fichier temporaire pour l'upload
                const fs = require('fs');
                const tempPath = `/tmp/event-image-${Date.now()}.jpg`;
                fs.writeFileSync(tempPath, imageBuffer);
                
                const fileInput = await page.$('input[type="file"]');
                await fileInput.uploadFile(tempPath);
                
                // Nettoyer le fichier temporaire
                fs.unlinkSync(tempPath);
            }
        }
        
        // Soumettre le formulaire
        await page.click('button[type="submit"]');
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
        
        console.log('✅ Événement publié sur Eventim Light');
        return { success: true, platform: 'eventim' };
        
    } catch (error) {
        console.error('❌ Erreur Eventim Light:', error);
        return { success: false, platform: 'eventim', error: error.message };
    } finally {
        await browser.close();
    }
}

// Fonction de publication sur JDS
async function publishToJDS(eventData) {
    const browser = await puppeteer.launch({
        headless: process.env.NODE_ENV === 'production',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        
        // 1. Connexion
        console.log('Connexion à JDS...');
        await page.goto('https://www.jds.fr/organisateur/connexion', { waitUntil: 'networkidle2' });
        
        await page.type('input[name="email"]', CREDENTIALS.jds.email);
        await page.type('input[name="password"]', CREDENTIALS.jds.password);
        await page.click('button[type="submit"]');
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
        
        // 2. Créer un événement
        console.log('Création de l\'événement sur JDS...');
        await page.goto('https://www.jds.fr/organisateur/ajouter-evenement', { waitUntil: 'networkidle2' });
        
        // Remplir le formulaire
        await page.type('input[name="title"]', eventData.title);
        
        // Type d'événement
        await page.select('select[name="eventType"]', 'Concert');
        
        // Dates
        const eventDate = new Date(eventData.date);
        await page.evaluate((dateStr) => {
            const dateInput = document.querySelector('input[name="startDate"]');
            dateInput.value = dateStr;
            dateInput.dispatchEvent(new Event('change', { bubbles: true }));
        }, eventDate.toISOString().split('T')[0]);
        
        // Horaires
        await page.type('input[name="startTime"]', eventData.time || '20:00');
        
        // Lieu
        await page.type('input[name="venue"]', eventData.venue);
        await page.type('input[name="address"]', eventData.address);
        
        // Prix - Gratuit
        await page.click('input[id="free"]');
        
        // Description structurée
        const jdsDescription = `
${eventData.description}

━━━━━━━━━━━━━━━━━━━━━━
📍 RÉSERVATION OFFICIELLE SUR HORMUR.COM
━━━━━━━━━━━━━━━━━━━━━━

Cette inscription sur JDS est une PRÉ-RÉSERVATION.
Pour valider votre participation et recevoir l'adresse exacte :
👉 ${eventData.eventUrl}

✨ Hormur révolutionne l'expérience culturelle en proposant des événements dans des lieux insolites et intimes.

ℹ️ L'adresse exacte sera communiquée uniquement aux personnes ayant réservé sur Hormur.com
        `.trim();
        
        await page.type('textarea[name="description"]', jdsDescription);
        
        // Informations pratiques
        await page.type('input[name="phone"]', '+33 7 82 57 93 78'); // Numéro Hormur
        await page.type('input[name="email"]', 'contact@hormur.com');
        await page.type('input[name="website"]', eventData.eventUrl);
        
        // Image
        if (eventData.imageUrl) {
            const imageBuffer = await processImage(eventData.imageUrl);
            if (imageBuffer) {
                const fs = require('fs');
                const tempPath = `/tmp/jds-image-${Date.now()}.jpg`;
                fs.writeFileSync(tempPath, imageBuffer);
                
                const fileInput = await page.$('input[type="file"][name="image"]');
                await fileInput.uploadFile(tempPath);
                
                fs.unlinkSync(tempPath);
            }
        }
        
        // Publier
        await page.click('button[name="publish"]');
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
        
        console.log('✅ Événement publié sur JDS');
        return { success: true, platform: 'jds' };
        
    } catch (error) {
        console.error('❌ Erreur JDS:', error);
        return { success: false, platform: 'jds', error: error.message };
    } finally {
        await browser.close();
    }
}

// Fonction de publication sur AllEvents
async function publishToAllEvents(eventData) {
    const browser = await puppeteer.launch({
        headless: process.env.NODE_ENV === 'production',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        
        // 1. Connexion
        console.log('Connexion à AllEvents...');
        await page.goto('https://allevents.in/organizer/login', { waitUntil: 'networkidle2' });
        
        // Se connecter avec email
        await page.click('button:has-text("Continue with Email")');
        await page.waitForTimeout(1000);
        
        await page.type('input[type="email"]', CREDENTIALS.allevents.email);
        await page.click('button:has-text("Continue")');
        
        await page.waitForTimeout(1500);
        await page.type('input[type="password"]', CREDENTIALS.allevents.password);
        await page.click('button:has-text("Login")');
        
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
        
        // 2. Créer un événement - AllEvents permet l'import depuis Eventbrite
        console.log('Import de l\'événement sur AllEvents...');
        await page.goto('https://allevents.in/organizer/create-event', { waitUntil: 'networkidle2' });
        
        // Option d'import depuis URL externe
        await page.click('button:has-text("Import from other platforms")');
        await page.waitForTimeout(1000);
        
        // Entrer l'URL Eventbrite ou Hormur
        await page.type('input[name="eventUrl"]', eventData.eventUrl);
        
        // Soumettre l'import
        await page.click('button:has-text("Import")');
        await page.waitForTimeout(3000);
        
        // Vérifier et publier
        await page.click('button:has-text("Publish")');
        
        console.log('✅ Événement publié sur AllEvents');
        return { success: true, platform: 'allevents' };
        
    } catch (error) {
        console.error('❌ Erreur AllEvents:', error);
        return { success: false, platform: 'allevents', error: error.message };
    } finally {
        await browser.close();
    }
}

// Configuration des workers pour les queues
eventimQueue.process(async (job) => {
    console.log(`Processing Eventim job ${job.id}`);
    return await publishToEventimLight(job.data);
});

jdsQueue.process(async (job) => {
    console.log(`Processing JDS job ${job.id}`);
    return await publishToJDS(job.data);
});

alleventsQueue.process(async (job) => {
    console.log(`Processing AllEvents job ${job.id}`);
    return await publishToAllEvents(job.data);
});

// Endpoint principal pour recevoir les webhooks de Make
app.post('/api/publish-event', async (req, res) => {
    try {
        const eventData = req.body;
        
        // Validation des données requises
        if (!eventData.title || !eventData.date) {
            return res.status(400).json({ 
                error: 'Données manquantes: title et date sont requis' 
            });
        }
        
        // Formater les données pour s'assurer de la cohérence
        const formattedData = {
            title: eventData.title,
            description: eventData.description || '',
            date: eventData.date,
            time: eventData.time || '20:00',
            venue: eventData.venue || 'Lieu à confirmer',
            address: eventData.address || 'Paris',
            imageUrl: eventData.imageUrl,
            eventUrl: eventData.eventUrl || 'https://hormur.com',
            category: eventData.category || 'Concert'
        };
        
        // Ajouter aux queues pour traitement asynchrone
        const eventimJob = await eventimQueue.add(formattedData);
        const jdsJob = await jdsQueue.add(formattedData);
        const alleventsJob = await alleventsQueue.add(formattedData);
        
        res.json({
            success: true,
            message: 'Événement ajouté aux files d\'attente',
            jobs: {
                eventim: eventimJob.id,
                jds: jdsJob.id,
                allevents: alleventsJob.id
            }
        });
        
    } catch (error) {
        console.error('Erreur webhook:', error);
        res.status(500).json({ 
            error: 'Erreur lors du traitement de l\'événement',
            details: error.message 
        });
    }
});

// Endpoint pour obtenir le statut des jobs
app.get('/api/status', async (req, res) => {
    try {
        const eventimCounts = await eventimQueue.getJobCounts();
        const jdsCounts = await jdsQueue.getJobCounts();
        const alleventsCounts = await alleventsQueue.getJobCounts();
        
        res.json({
            eventim: eventimCounts,
            jds: jdsCounts,
            allevents: alleventsCounts
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Endpoint pour tester une plateforme spécifique
app.post('/api/test/:platform', async (req, res) => {
    const { platform } = req.params;
    const testData = {
        title: `Test Hormur - ${new Date().toLocaleString('fr-FR')}`,
        description: 'Événement de test - Ne pas réserver',
        date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        time: '20:00',
        venue: 'Lieu Test',
        address: 'Paris',
        eventUrl: 'https://hormur.com/test',
        category: 'Concert'
    };
    
    let result;
    switch(platform) {
        case 'eventim':
            result = await publishToEventimLight(testData);
            break;
        case 'jds':
            result = await publishToJDS(testData);
            break;
        case 'allevents':
            result = await publishToAllEvents(testData);
            break;
        default:
            return res.status(400).json({ error: 'Plateforme non reconnue' });
    }
    
    res.json(result);
});

// Servir l'interface HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Démarrer le serveur
app.listen(PORT, () => {
    console.log(`🚀 Serveur Hormur Automation démarré sur le port ${PORT}`);
    console.log(`📡 Webhook endpoint: http://localhost:${PORT}/api/publish-event`);
});

module.exports = app;