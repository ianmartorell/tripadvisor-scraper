const querystring = require('querystring');
const axios = require('axios');
const moment = require('moment');
const { ReviewQuery } = require('./graphql-queries');

const { API_KEY } = process.env;

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
    let error;
    let result;
    try {
        result = await axios.post(
            `https://api.tripadvisor.com/api/internal/1.14/typeahead?${queryString}`,
            {},
            { headers: { 'X-TripAdvisor-API-Key': API_KEY } },
        );
    } catch (e) {
        error = e;
    }
    const { data } = result.data;

    if (!data || error) {
        throw new Error(`Could not find location "${searchString}" reason: ${error.message}`);
    }
    return data[0].result_object.location_id;
}

async function getPlacePrices(placeId, delay) {
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
        await delay();
        return getPlacePrices(placeId, delay);
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
