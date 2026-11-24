import type { ContactPageSeed } from '@mission-control/payload-jobs'

/**
 * Vanuatu Wok's contact page (PJ-102), recreated from the legacy /contact page: a form with
 * "Your Name", "Company Name", "Your email" and "Message", then a map.
 *
 * The field labels are the legacy page's. The map centre is the coordinate the legacy page's
 * Google embed used (Wok I Kik, run by Youth Challenge Vanuatu, Port Vila); the embed itself
 * needed no key, and neither does this one.
 */
export const vwokContact: ContactPageSeed = {
  fields: [
    { kind: 'text', label: 'Your Name', name: 'your-name', required: true },
    { kind: 'text', label: 'Company Name', name: 'company-name' },
    { kind: 'email', label: 'Your email', name: 'your-email', required: true },
    { kind: 'textarea', label: 'Message', name: 'message', required: true },
  ],
  formTitle: 'Contact',
  heading: 'Contact us',
  map: {
    heading: 'Find us',
    height: 'medium',
    latitude: -17.74950459695074,
    longitude: 168.31487247573503,
    provider: 'google',
    title: 'Vanuatu Wok on the map',
    zoom: 16,
  },
}
