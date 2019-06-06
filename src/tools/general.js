const axios = require('axios');
const Apify = require('apify');
const cheerio = require('cheerio');
const moment = require('moment');
const check = require('check-types');

const {
    callForReview,
    getPlacePrices,
    buildHotelUrl,
    buildRestaurantUrl,
    getPlaceInformation,
    buildAttractionsUrl,
    callForAttractionList,
    callForAttractionReview,
    getAgentOptions,
    getReviewTagsForLocation,
    callForRestaurantList,
} = require('./api');

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

function findLastReviewIndex(reviews, dateKey) {
    return reviews.findIndex((r) => {
        let rDate;
        if (dateKey) {
            rDate = moment(r[dateKey]);
        } else {
            rDate = moment(r.publishedDate);
        }
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
    let response;

    try {
        for (let i = 0; i < numberOfFetches; i++) {
            offset += limit;
            response = await callForReview(id, client, offset, limit);
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

async function processHotel(placeInfo, client, dataset) {
    const { location_id: id } = placeInfo;
    let reviews = [];
    let placePrices;

    try {
        placePrices = await getPlacePrices(id, randomDelay);
    } catch (e) {
        log.warning('Hotels: Could not get place prices', { errorMessage: e.message });
    }

    if (global.INCLUDE_REVIEWS) {
        try {
            reviews = await getReviews(id, client);
        } catch (e) {
            log.error('Could not get reviews', e);
        }
    }

    if (!placeInfo) {
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
        latitude: placeInfo.latitude,
        longitude: placeInfo.longitude,
        webUrl: placeInfo.web_url,
        website: placeInfo.website,
        reviews,
    };
    if (global.INCLUDE_REVIEW_TAGS) {
        const tags = await getReviewTags(id);
        place.reviewTags = tags;
    }
    log.debug('Data for hotel: ', place);
    if (dataset) {
        await dataset.pushData(place);
    } else {
        await Apify.setValue('OUTPUT', JSON.stringify(place), { contentType: 'application/json' });
    }
}


function getRequestListSources(locationId, includeHotels, includeRestaurants, includeAttractions) {
    const sources = [];
    if (includeHotels) {
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
    if (includeAttractions) {
        sources.push({
            url: buildAttractionsUrl(locationId),
            userData: {
                initialAttraction: true,
            },
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


async function processRestaurant(placeInfo, client, dataset) {
    const { location_id: id } = placeInfo;
    let reviews = [];
    if (global.INCLUDE_REVIEWS) {
        try {
            reviews = await getReviews(id, client);
        } catch (e) {
            log.error('Could not get reviews', e);
        }
    }
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
        latitude: placeInfo.latitude,
        longitude: placeInfo.longitude,
        webUrl: placeInfo.web_url,
        website: placeInfo.website,
        numberOfReviews: placeInfo.num_reviews,
        rankingDenominator: placeInfo.ranking_denominator,
        reviews,
    };
    if (global.INCLUDE_REVIEW_TAGS) {
        const tags = await getReviewTags(id);
        place.reviewTags = tags;
    }
    log.debug('Data for restaurant: ', place);

    if (dataset) {
        await dataset.pushData(place);
    } else {
        await Apify.setValue('OUTPUT', JSON.stringify(place), { contentType: 'application/json' });
    }
}

async function getClient() {
    const response = await axios.get('https://www.tripadvisor.com/', getAgentOptions());
    const $ = cheerio.load(response.data);
    return axios.create({
        baseURL: 'https://www.tripadvisor.co.uk/data/graphql',
        headers: {
            'x-requested-by': getSecurityToken($),
            Cookie: getCookies(response),
        },
        ...getAgentOptions(),
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
        includeAttractions,
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
    checkBooleanProperty(includeAttractions, 'includeAttractions');

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
    if (!includeHotels && !includeRestaurants && !includeAttractions) {
        throw new Error('At least one of properties: includeHotels or includeRestaurants should be true');
    }
    log.info('Input validation OK');
}

async function getAttractions(locationId) {
    let attractions = [];
    let offset = 0;
    const limit = 20;
    const data = await callForAttractionList(locationId, limit);
    attractions = attractions.concat(data.data);
    if (data.paging && data.paging.next) {
        const totalResults = data.paging.total_results;
        const numberOfRuns = Math.ceil(totalResults / limit);
        log.info(`Going to process ${numberOfRuns} pages of attractions`);
        for (let i = 0; i <= numberOfRuns; i++) {
            offset += limit;
            const data2 = await callForAttractionList(locationId, limit, offset);
            attractions = attractions.concat(data2.data);
        }
    }
    return attractions;
}

async function getReviewTags(locationId) {
    let tags = [];
    let offset = 0;
    const limit = 20;
    const data = await getReviewTagsForLocation(locationId, limit);
    tags = tags.concat(data.data);
    if (data.paging && data.paging.next) {
        const totalResults = data.paging.total_results;
        const numberOfRuns = Math.ceil(totalResults / limit);
        log.info(`Going to process ${numberOfRuns} pages of ReviewTags, ${data.paging}`);
        for (let i = 0; i <= numberOfRuns; i++) {
            offset += limit;
            const data2 = await getReviewTagsForLocation(locationId, limit, offset);
            tags = tags.concat(data2.data);
        }
    }
    return tags;
}
function processAttractionReview(review) {
    const {
        lang,
        text,
        published_date: publishedDate,
        rating,
        travel_date: travelDate,
        user,
        title,
        machine_translated: machineTranslated,
        subratings,
    } = review;

    return {
        language: lang,
        title,
        text,
        publishedDate,
        rating,
        travelDate,
        user: {
            username: user.username,
            helpfulVotes: user.helpful_votes,

        },
        subratings,
        machineTranslated,
    };
}

async function getReviewsForAttraction(locationId) {
    const reviews = [];
    let offset = 0;
    const limit = 50;
    const data = await callForAttractionReview(locationId, limit);
    let { data: revs } = data;
    let lastIndex = findLastReviewIndex(revs, 'published_date');
    let shouldSlice = lastIndex >= 0;
    if (shouldSlice) {
        revs = revs.slice(0, lastIndex);
    }
    revs.forEach(review => reviews.push(processAttractionReview(review)));
    if (shouldSlice) return reviews;
    if (data.paging && data.paging.next) {
        const totalResults = data.paging.total_results;
        const numberOfRuns = Math.ceil(totalResults / limit);
        log.info(`Going to process ${numberOfRuns} pages of reviews`);
        for (let i = 0; i <= numberOfRuns; i++) {
            offset += limit;
            let { data: reviewsToPush } = await callForAttractionReview(locationId, limit, offset);
            lastIndex = findLastReviewIndex(reviewsToPush, 'published_date');
            shouldSlice = lastIndex >= 0;
            if (shouldSlice) {
                reviewsToPush = reviewsToPush.slice(0, lastIndex);
            }
            reviewsToPush.forEach(review => reviews.push(processAttractionReview(review)));
            if (shouldSlice) break;
        }
    }
    return reviews;
}

async function getAttractionDetail(attraction) {
    log.info(`Processing detail for ${attraction.name} attraction`);
    const locationId = attraction.location_id;
    let reviews = [];
    if (global.INCLUDE_REVIEWS) {
        try {
            reviews = await getReviewsForAttraction(locationId);
            log.info(`Got ${reviews.length} reviews for ${attraction.name}`);
        } catch (e) {
            log.error(`Could not get reviews for attraction ${attraction.name} due to ${e.message}`);
        }
    }

    attraction.reviews = reviews;
    return attraction;
}

async function processAttraction(attraction) {
    const attr = await getAttractionDetail(attraction);
    if (global.includeTagsInReviews) {
    }
    return Apify.pushData(attr);
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
    getAttractions,
    processAttraction,
};
