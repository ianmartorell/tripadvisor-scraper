const axios = require('axios');
const Apify = require('apify');
const cheerio = require('cheerio');
const moment = require('moment');
const check = require('check-types');
const { callForReview, getPlacePrices, buildHotelUrl, buildRestaurantUrl, getPlaceInformation } = require('./api');

const { utils: { log } } = Apify;

function randomDelay(minimum = 200, maximum = 600) {
    const min = Math.ceil(minimum);
    const max = Math.floor(maximum);
    return Apify.utils.sleep(Math.floor(Math.random() * (max - min + 1)) + min);
}

function getSecurityToken($) {
    let securityToken = null;
    $('script').each((index, element) => {
        if ($(element).get()[0].children[0] && $(element).get()[0].children[0].data.includes('define(\'page-model\'')) {
            const { data } = $(element).get()[0].children[0];
            [a, securityToken] = data.split(',').find(row => row.includes('JS_SECURITY_TOKEN')).split(':');
            return false;
        }
    });
    return securityToken.replace(/"/g, '');
}

function getCookies(response) {
    let sessionCookie = null;
    let taudCookie = null;
    response.headers['set-cookie'].forEach((d) => {
        if (d.includes('TASession')) {
            [sessionCookie] = d.split(';');
        }
        if (d.includes('TAUD')) {
            [taudCookie] = d.split(';');
        }
    });
    return `${sessionCookie};${taudCookie}`;
}

async function resolveInBatches(promiseArray, batchLength = 10) {
    const promises = [];
    for (const promise of promiseArray) {
        if (typeof promise === 'function') {
            promises.push(promise());
        } else {
            promises.push(promise);
        }
        if (promises.length % batchLength === 0) await Promise.all(promises);
    }
    return Promise.all(promises);
}

function getHotelIds($) {
    const hotelIds = [];
    const divs = $('.prw_rup.prw_meta_hsx_responsive_listing.ui_section.listItem');
    divs.each((index, element) => {
        const el = $(element).find('.meta_listing');
        const placeId = el.attr('data-locationid');
        hotelIds.push(placeId);
    });
    return hotelIds;
}

const processReview = (review, remoteId) => {
    const { text, title, rating, tripInfo, publishedDate, userProfile } = review;
    const stayDate = tripInfo ? tripInfo.stayDate : null;
    let userLocation = null;
    let userContributions = null;

    log.debug(`Processing review: ${title}`);
    if (userProfile) {
        const { hometown, contributionCounts } = userProfile;
        const { sumReview } = contributionCounts;
        userContributions = sumReview;
        userLocation = hometown.fallbackString;

        if (hometown.location) {
            userLocation = hometown.location.additionalNames.long;
        }
    }

    return {
        text,
        title,
        rating,
        stayDate,
        publishedDate,
        userLocation,
        userContributions,
        remoteId,
    };
};

function findLastReviewIndex(reviews) {
    return reviews.findIndex((r) => {
        const rDate = moment(r.publishedDate);
        const userMaxDate = moment(global.LAST_REVIEW_DATE);
        return rDate.isBefore(userMaxDate);
    });
}

async function getReviews(id, client) {
    const result = [];
    let offset = 0;
    const limit = 20;
    let numberOfFetches = 0;

    try {
        const resp = await callForReview(id, client, offset, limit);
        const { errors } = resp.data[0];

        if (errors) {
            log.error('Graphql error', errors);
        }

        const reviewData = resp.data[0].data.locations[0].reviewList;
        const { totalCount } = reviewData;
        let { reviews } = reviewData;
        const lastIndex = findLastReviewIndex(reviews);
        const shouldSlice = lastIndex >= 0;
        if (shouldSlice) {
            reviews = reviews.slice(0, lastIndex);
        }
        const needToFetch = totalCount - limit;

        log.info(`Going to process ${totalCount} reviews`);

        numberOfFetches = Math.ceil(needToFetch / limit);
        reviews.forEach(review => result.push(processReview(review)));
        if (shouldSlice) return result;
    } catch (e) {
        log.error(e, 'Could not make initial request');
    }

    try {
        for (let i = 0; i < numberOfFetches; i++) {
            offset += limit;
            const response = await callForReview(id, client, offset, limit);
            const reviewData = response.data[0].data.locations[0].reviewList;
            let { reviews } = reviewData;
            const lastIndex = findLastReviewIndex(reviews);
            const shouldSlice = lastIndex >= 0;
            if (shouldSlice) {
                reviews = reviews.slice(0, lastIndex);
            }
            reviews.forEach(review => result.push(processReview(review)));
            if (shouldSlice) break;
            await Apify.utils.sleep(300);
        }
    } catch (e) {
        log.error(e, 'Could not make additional requests');
    }
    return result;
}

async function getPlaceInfoAndReview(id, client) {
    let placeInfo;
    let reviews = [];
    if (global.INCLUDE_REVIEWS) {
        try {
            reviews = await getReviews(id, client);
        } catch (e) {
            log.error('Could not get reviews', e);
        }
    }

    try {
        placeInfo = await getPlaceInformation(id);
    } catch (e) {
        log.error('Could not get place info', e);
    }
    return { placeInfo, reviews };
}

async function processHotel(id, client, dataset) {
    let placePrices;
    const { reviews, placeInfo } = await getPlaceInfoAndReview(id, client);
    try {
        placePrices = await getPlacePrices(id, randomDelay);
    } catch (e) {
        log.warning('Hotels: Could not get place prices', { errorMessage: e.message });
    }

    if (!placeInfo || !reviews) {
        return;
    }
    const prices = placePrices ? placePrices.offers.map(offer => ({
        provider: offer.provider_display_name,
        price: offer.display_price_int ? offer.display_price_int : 'NOT_PROVIDED',
        isBookable: offer.is_bookable,
        link: offer.link,
    })) : [];
    const place = {
        id: placeInfo.location_id,
        type: 'HOTEL',
        name: placeInfo.name,
        awards: placeInfo.awards.map(award => ({ year: award.year, name: award.display_name })),
        rankingPosition: placeInfo.ranking_position,
        priceLevel: placeInfo.price_level,
        category: placeInfo.ranking_category,
        rating: placeInfo.rating,
        hotelClass: placeInfo.hotel_class,
        hotelClassAttribution: placeInfo.hotel_class_attribution,
        phone: placeInfo.phone,
        address: placeInfo.address,
        email: placeInfo.email,
        amenities: placeInfo.amenities.map(amenity => amenity.name),
        prices,
        reviews,
    };
    log.debug('Data for hotel: ', place);
    if (dataset) {
        await dataset.pushData(place);
    } else {
        await Apify.setValue('OUTPUT', JSON.stringify(place), { contentType: 'application/json' });
    }
}


function getRequestListSources(locationId, includeHotesl, includeRestaurants) {
    const sources = [];
    if (includeHotesl) {
        sources.push({
            url: buildHotelUrl(locationId),
            userData: { initialHotel: true },
        });
    }
    if (includeRestaurants) {
        sources.push({
            url: buildRestaurantUrl(locationId),
            userData: { initialRestaurant: true },
        });
    }
    return sources;
}

function getRestaurantIds($) {
    const ids = [];
    $('.listing.rebrand').each((index, element) => {
        const id = $(element).attr('id');
        if (id) {
            const split = id.split('_');
            ids.push(split[split.length - 1]);
        }
    });
    return ids;
}

function getHours(placeInfo) {
    const placeHolder = [];

    if (!placeInfo.hours) {
        return placeHolder;
    }

    if (!placeInfo.hours.week_ranges) {
        return placeHolder;
    }

    return placeInfo.hours.week_ranges.map(wR => wR.map(day => ({ open: day.open_time, close: day.close_time })));
}


async function processRestaurant(id, client, dataset) {
    const { reviews, placeInfo } = await getPlaceInfoAndReview(id, client);
    if (!placeInfo) {
        return;
    }
    const place = {
        id: placeInfo.location_id,
        type: 'RESTAURANT',
        name: placeInfo.name,
        awards: placeInfo.awards.map(award => ({ year: award.year, name: award.display_name })),
        rankingPosition: placeInfo.ranking_position,
        priceLevel: placeInfo.price_level,
        category: placeInfo.ranking_category,
        rating: placeInfo.rating,
        isClosed: placeInfo.is_closed,
        isLongClosed: placeInfo.is_long_closed,
        phone: placeInfo.phone,
        address: placeInfo.address,
        email: placeInfo.email,
        cuisine: placeInfo.cuisine.map(cuisine => cuisine.name),
        mealTypes: placeInfo.mealTypes && placeInfo.mealTypes.map(m => m.name),
        hours: getHours(placeInfo),
        reviews,
    };
    log.debug('Data for restaurant: ', place);

    if (dataset) {
        await dataset.pushData(place);
    } else {
        await Apify.setValue('OUTPUT', JSON.stringify(place), { contentType: 'application/json' });
    }
}

async function getClient() {
    const response = await axios.get('https://www.tripadvisor.com/');
    const $ = cheerio.load(response.data);
    return axios.create({
        baseURL: 'https://www.tripadvisor.co.uk/data/graphql',
        headers: {
            'x-requested-by': getSecurityToken($),
            Cookie: getCookies(response),
        },
    });
}
function validateInput(input) {
    const {
        locationFullName,
        hotelId,
        restaurantId,
        includeRestaurants,
        includeHotels,
        includeReviews,
        lastReviewDate,
        checkInDate,
    } = input;
    const getError = (property, type = 'string') => new Error(`${property} should be a ${type}`);
    const checkStringProperty = (property, propertyName) => {
        if (property && !check.string(property)) {
            throw getError(propertyName);
        }
    };
    const checkBooleanProperty = (property, propertyName) => {
        if (property && !check.boolean(property)) {
            throw getError(propertyName, 'boolean');
        }
    };

    const checkDateFormat = (date, format = 'YYYY-MM-DD') => {
        if (moment(date, format).format(format) !== date) {
            throw new Error(`Date: ${date} should be in format ${format}`);
        }
    };

    // Check types
    // strings
    checkStringProperty(locationFullName, 'locationFullName');
    checkStringProperty(hotelId, 'hotelId');
    checkStringProperty(restaurantId, 'restaurantId');
    checkStringProperty(lastReviewDate, 'lasReviewData');

    // boleans
    checkBooleanProperty(includeRestaurants, 'includeRestaurants');
    checkBooleanProperty(includeHotels, 'includeHotels');
    checkBooleanProperty(includeReviews, 'includeReviews');

    // dates
    if (lastReviewDate) {
        checkDateFormat(lastReviewDate);
    }
    if (checkInDate) {
        checkDateFormat(checkInDate);
    }

    // Should have all required fields
    if (!locationFullName && !hotelId && !restaurantId) {
        throw new Error('At least one of properties: locationFullName, hotelId, restaurantId should be set');
    }
    if (!includeHotels && !includeRestaurants) {
        throw new Error('At least one of properties: includeHotels or includeRestaurants should be true');
    }
    log.info('Input validation OK');
}


module.exports = {
    resolveInBatches,
    getHotelIds,
    processHotel,
    getRequestListSources,
    getRestaurantIds,
    processRestaurant,
    getClient,
    randomDelay,
    validateInput,
};
