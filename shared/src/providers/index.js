const sms = require('./sms');
const email = require('./email');
const push = require('./push');
const whatsapp = require('./whatsapp');
const mapsMod = require('./maps');
const couriers = require('./couriers');
const oauth = require('./oauth');
const paypal = require('./paypal');
const callerid = require('./callerid');
const terminal = require('./terminal');

/** Field names treated as secrets (encrypted at rest, masked on GET). */
const SECRET_FIELDS = {
  sms: ['auth_token'],
  smtp: ['password'],
  firebase: ['server_key', 'service_account_json', 'service_file_content'],
  whatsapp: ['access_token'],
  maps: ['api_key'],
  postcode: ['api_key'],
  callerid: ['password', 'webhook_secret'],
  uber_direct: ['client_secret'],
  stuart: ['client_secret'],
  justeat: ['api_key'],
  deliveroo: ['client_secret'],
  ubereats: ['client_secret'],
  paypal: ['client_secret'],
  google_login: ['client_secret'],
  facebook_login: ['app_secret'],
  apple_login: ['private_key'],
  recaptcha: ['secret_key'],
};

const PROVIDERS = {
  sms,
  smtp: email,
  firebase: push,
  whatsapp,
  maps: mapsMod.maps,
  postcode: mapsMod.postcode,
  callerid,
  uber_direct: couriers.uber_direct,
  stuart: couriers.stuart,
  justeat: couriers.justeat,
  deliveroo: couriers.deliveroo,
  ubereats: couriers.ubereats,
  paypal,
  google_login: oauth.google_login,
  facebook_login: oauth.facebook_login,
  apple_login: oauth.apple_login,
  recaptcha: oauth.recaptcha,
};

function getProvider(id) {
  return PROVIDERS[id] || null;
}

function secretFieldsFor(id) {
  return SECRET_FIELDS[id] || [];
}

module.exports = {
  PROVIDERS,
  getProvider,
  secretFieldsFor,
  SECRET_FIELDS,
  terminal,
  sms,
  email,
  push,
  whatsapp,
};
