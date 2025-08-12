// netlify/functions/publish-event.js
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const axios = require('axios');

// Configuration des identifiants
const CREDENTIALS = {
    eventim: {
        email: process.env.EVENTIM_EMAIL || 'martin.jeudy@hormur.com',
        password: process.env.EVENTIM_PASSWORD || 'fXjP36mb5uRnvE!'
    },
    jds: {
        email: process.env.JDS_EMAIL || 'contact@hormur.com',
        password: process.env.JDS_PASSWORD || 'xl2DQ3@T2*HYex'
    },
    allevents: {
        email: process.env.ALLEVENTS_EMAIL || 'martin.jeudy@hormur.com',
        password: process.env.ALLEVENTS_PASSWORD || 'hBH42F2.cnBjm.'
    }
};

// Fonction principale pour Netlify
exports.handler = async (event, context) => {
    // Gérer les requêtes OPTIONS pour CORS
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            }
        };
    }

    // Vérifier la méthode HTTP
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        const eventData = JSON.parse(event.body);
        
        // Validation des données
        if (!eventData.title || !eventData.date) {
            return {
                statusCode: 400,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    error: 'Données manquantes: title et date sont requis' 
                })
            };
        }

        // Formater les données
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

        // Lancer les publications en parallèle
        const results = await Promise.allSettled([
            publishToEventimLight(formattedData),
            publishToJDS(formattedData),
            publishToAllEvents(formattedData)
        ]);

        // Analyser les résultats
        const response = {
            success: true,
            results: {
                eventim: results[0].status === 'fulfilled' ? results[0].value : { error: results[0].reason },
                jds: results[1].status === 'fulfilled' ? results[1].value : { error: results[1].reason },
                allevents: results[2].status === 'fulfilled' ? results[2].value : { error: results[2].reason }
            }
        };

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify(response)
        };

    } catch (error) {
        console.error('Erreur:', error);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                error: 'Erreur lors du traitement',
                details: error.message 
            })
        };
    }
};

// Fonction optimisée pour Eventim Light (serverless)
async function publishToEventimLight(eventData) {
    let browser = null;
    
    try {
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless
        });

        const page = await browser.newPage();
        
        // Connexion
        await page.goto('https://www.eventim-light.com/fr/login', { 
            waitUntil: 'domcontentloaded',
            timeout: 30000 
        });
        
        // Accepter cookies si présent
        const cookieButton = await page.$('[data-testid="cookie-accept-all"]');
        if (cookieButton) await cookieButton.click();
        
        // Login
        await page.waitForSelector('input[type="email"]', { timeout: 10000 });
        await page.type('input[type="email"]', CREDENTIALS.eventim.email);
        await page.type('input[type="password"]', CREDENTIALS.eventim.password);
        
        await Promise.all([
            page.click('button[type="submit"]'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded' })
        ]);
        
        // Créer événement
        await page.goto('https://www.eventim-light.com/fr/evenements/nouveau', { 
            waitUntil: 'domcontentloaded' 
        });
        
        // Remplir le formulaire (version simplifiée)
        await page.evaluate((data) => {
            // Titre
            const titleInput = document.querySelector('input[name="eventName"]');
            if (titleInput) {
                titleInput.value = data.title;
                titleInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
            
            // Date
            const dateInput = document.querySelector('input[name="eventDate"]');
            if (dateInput) {
                const date = new Date(data.date);
                dateInput.value = date.toISOString().split('T')[0];
                dateInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
            
            // Heure
            const timeInput = document.querySelector('input[name="eventTime"]');
            if (timeInput) {
                timeInput.value = data.time;
                timeInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
            
            // Lieu
            const venueInput = document.querySelector('input[name="venueName"]');
            if (venueInput) {
                venueInput.value = data.venue;
                venueInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
            
            // Description
            const descTextarea = document.querySelector('textarea[name="description"]');
            if (descTextarea) {
                descTextarea.value = `${data.description}\n\n🎭 RÉSERVATION OFFICIELLE : ${data.eventUrl}\n⚠️ Ceci est une pré-réservation. Billets valables uniquement sur Hormur.com`;
                descTextarea.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, eventData);
        
        // Sélectionner "Gratuit"
        const freeOption = await page.$('input[value="free"]');
        if (freeOption) await freeOption.click();
        
        // Soumettre
        await page.click('button[type="submit"]');
        await page.waitForTimeout(3000);
        
        return { 
            success: true, 
            platform: 'eventim',
            message: 'Événement publié sur Eventim Light'
        };
        
    } catch (error) {
        console.error('Erreur Eventim:', error);
        return { 
            success: false, 
            platform: 'eventim', 
            error: error.message 
        };
    } finally {
        if (browser) await browser.close();
    }
}

// Fonction optimisée pour JDS (serverless)
async function publishToJDS(eventData) {
    let browser = null;
    
    try {
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless
        });

        const page = await browser.newPage();
        
        // Connexion
        await page.goto('https://www.jds.fr/organisateur/connexion', { 
            waitUntil: 'domcontentloaded' 
        });
        
        await page.type('input[name="email"]', CREDENTIALS.jds.email);
        await page.type('input[name="password"]', CREDENTIALS.jds.password);
        
        await Promise.all([
            page.click('button[type="submit"]'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded' })
        ]);
        
        // Créer événement
        await page.goto('https://www.jds.fr/organisateur/ajouter-evenement', { 
            waitUntil: 'domcontentloaded' 
        });
        
        // Remplir formulaire via JavaScript pour plus de rapidité
        await page.evaluate((data) => {
            // Titre
            const titleInput = document.querySelector('input[name="title"]');
            if (titleInput) titleInput.value = data.title;
            
            // Date
            const dateInput = document.querySelector('input[name="startDate"]');
            if (dateInput) {
                const date = new Date(data.date);
                dateInput.value = date.toISOString().split('T')[0];
            }
            
            // Heure
            const timeInput = document.querySelector('input[name="startTime"]');
            if (timeInput) timeInput.value = data.time;
            
            // Lieu
            const venueInput = document.querySelector('input[name="venue"]');
            if (venueInput) venueInput.value = data.venue;
            
            const addressInput = document.querySelector('input[name="address"]');
            if (addressInput) addressInput.value = data.address;
            
            // Description
            const descTextarea = document.querySelector('textarea[name="description"]');
            if (descTextarea) {
                descTextarea.value = `${data.description}\n\n━━━━━━━━━━━━━━━━━━━━━━\n📍 RÉSERVATION OFFICIELLE SUR HORMUR.COM\n━━━━━━━━━━━━━━━━━━━━━━\n\n👉 ${data.eventUrl}\n\n✨ Lieu insolite - Adresse communiquée après réservation`;
            }
            
            // Contact
            const phoneInput = document.querySelector('input[name="phone"]');
            if (phoneInput) phoneInput.value = '+33 7 82 57 93 78';
            
            const emailInput = document.querySelector('input[name="email"]');
            if (emailInput) emailInput.value = 'contact@hormur.com';
            
            const websiteInput = document.querySelector('input[name="website"]');
            if (websiteInput) websiteInput.value = data.eventUrl;
        }, eventData);
        
        // Gratuit
        const freeCheckbox = await page.$('#free');
        if (freeCheckbox) await freeCheckbox.click();
        
        // Publier
        await page.click('button[name="publish"]');
        await page.waitForTimeout(3000);
        
        return { 
            success: true, 
            platform: 'jds',
            message: 'Événement publié sur JDS'
        };
        
    } catch (error) {
        console.error('Erreur JDS:', error);
        return { 
            success: false, 
            platform: 'jds', 
            error: error.message 
        };
    } finally {
        if (browser) await browser.close();
    }
}

// Fonction optimisée pour AllEvents (serverless)
async function publishToAllEvents(eventData) {
    let browser = null;
    
    try {
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless
        });

        const page = await browser.newPage();
        
        // Connexion simplifiée
        await page.goto('https://allevents.in/organizer/login', { 
            waitUntil: 'domcontentloaded' 
        });
        
        // Utiliser l'évaluation JavaScript pour remplir plus rapidement
        await page.evaluate((creds) => {
            // Simuler le processus de connexion
            const emailInput = document.querySelector('input[type="email"]');
            if (emailInput) {
                emailInput.value = creds.email;
                emailInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, CREDENTIALS.allevents);
        
        await page.waitForTimeout(1000);
        
        // Cliquer sur continuer si le bouton existe
        const continueBtn = await page.$('button:has-text("Continue")');
        if (continueBtn) {
            await continueBtn.click();
            await page.waitForTimeout(1500);
            
            // Entrer le mot de passe
            await page.type('input[type="password"]', CREDENTIALS.allevents.password);
            await page.click('button:has-text("Login")');
            await page.waitForNavigation({ waitUntil: 'domcontentloaded' });
        }
        
        // Créer/Importer événement
        await page.goto('https://allevents.in/organizer/create-event', { 
            waitUntil: 'domcontentloaded' 
        });
        
        // Essayer l'import direct avec l'URL
        await page.evaluate((url) => {
            const urlInput = document.querySelector('input[name="eventUrl"]');
            if (urlInput) {
                urlInput.value = url;
                urlInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, eventData.eventUrl);
        
        // Soumettre
        const submitButton = await page.$('button[type="submit"], button:has-text("Import"), button:has-text("Submit")');
        if (submitButton) {
            await submitButton.click();
            await page.waitForTimeout(3000);
        }
        
        return { 
            success: true, 
            platform: 'allevents',
            message: 'Événement publié sur AllEvents'
        };
        
    } catch (error) {
        console.error('Erreur AllEvents:', error);
        return { 
            success: false, 
            platform: 'allevents', 
            error: error.message 
        };
    } finally {
        if (browser) await browser.close();
    }
}