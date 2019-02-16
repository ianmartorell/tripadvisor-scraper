const querystring = require('querystring');
const axios = require('axios');
const moment = require('moment');

const { ReviewQuery } = require('./graphql-queries');
const { randomDelay } = require('./general');

const API_KEY = '3c7beec8-846d-4377-be03-71cae6145fdc';

function callForReview(placeId = 300974, client, offset = 0, limit = 100) {
    return client.post('/batched',
        [{
            operationName: 'ReviewListQuery',
            variables: {
                locationId: placeId,
                offset,
                filters: [],
                prefs: null,
                initialPrefs: {},
                limit,
                filterCacheKey: null,
                prefsCacheKey: 'hotelReviewPrefs',
                needKeywords: false,
                keywordVariant: 'location_keywords_v2_llr_order_30_en',
            },
            query: ReviewQuery,
        }]);
}

async function getLocationId(searchString) {
    const queryString = querystring.stringify({
        query: searchString,
        alternate_tag_name: true,
        auto_broaden: true,
        category_type: 'neighborhoods,geos',
        currency: 'USD',

    });
    const result = await axios.post(
        `https://api.tripadvisor.com/api/internal/1.14/typeahead?${queryString}`,
        {},
        { headers: { 'X-TripAdvisor-API-Key': API_KEY } },
    );
    const { data } = result.data;
    if (!result.data.data) {
        throw new Error(`Could not find location "${searchString}"`);
    }
    return data[0].result_object.location_id;
}

async function getPlacePrices(placeId) {
    const dateString = moment().format('YYYY-MM-DD');
    const response = await axios.get(
        `https://api.tripadvisor.com/api/internal/1.19/en/meta_hac/${placeId}?adults=2&checkin=${dateString}&currency=USD&lod=extended&nights=1`,
        { headers: { 'X-TripAdvisor-API-Key': API_KEY } },
    );
    const offers = response.data.data[0].hac_offers;
    const isLoaded = offers && offers.availability && offers.availability !== 'pending';
    if (!offers) {
        throw new Error(`Could not find offers for: ${placeId}`);
    }
    if (!isLoaded) {
        await randomDelay();
        return getPlacePrices(placeId);
    }
    return offers;
}

async function getPlaceInformation(placeId) {
    const response = await axios.get(
        `https://api.tripadvisor.com/api/internal/1.14/location/${placeId}`,
        { headers: { 'X-TripAdvisor-API-Key': API_KEY } },
    );
    return response.data;
}

function buildRestaurantUrl(locationId, offset) {
    return `https://www.tripadvisor.com/RestaurantSearch?Action=PAGE&geo=${locationId}&ajax=1&sortOrder=relevance&${offset ? `o=a${offset}` : ''}&availSearchEnabled=false`;
}

function buildHotelUrl(locationId, offset) {
    return `https://www.tripadvisor.com/Hotels-g${locationId}-${offset ? `oa${offset}` : ''}.html`;
}
module.exports = {
    callForReview,
    getLocationId,
    getPlacePrices,
    getPlaceInformation,
    buildHotelUrl,
    buildRestaurantUrl,
};
