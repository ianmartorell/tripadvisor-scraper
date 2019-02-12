const axios = require("axios");
const Apify = require('apify');
const cheerio =require("cheerio");
const {utils: {log}} = Apify;
const {ReviewQuery} = require("./graphql-queries");
const API_KEY = "3c7beec8-846d-4377-be03-71cae6145fdc";

function callForReview(placeId = 300974, client, offset = 0, limit = 100) {
    return client.post("/batched",
        [{
            "operationName": "ReviewListQuery",
            "variables": {
                "locationId": placeId,
                "offset": offset,
                "filters": [],
                "prefs": null,
                "initialPrefs": {},
                "limit": limit,
                "filterCacheKey": null,
                "prefsCacheKey": "hotelReviewPrefs",
                "needKeywords": false,
                "keywordVariant": "location_keywords_v2_llr_order_30_en"
            },
            "query": ReviewQuery
        }]
    );
}

function getSecurityToken($) {
    let securityToken = null;
    $("script").each((index, element) => {
        if ($(element).get()[0].children[0] && $(element).get()[0].children[0].data.includes('define(\'page-model\'')) {
            const data = $(element).get()[0].children[0].data;
            const securityPart = data.split(",").find(row => row.includes("JS_SECURITY_TOKEN")).split(":");
            securityToken = securityPart[1];
            return false;
        }
    });
    return securityToken.replace(/"/g, "");
}

function getCookies(response) {
    let sessionCookie = null;
    let taudCookie = null;
    response.headers["set-cookie"].forEach(d => {
        if (d.includes("TASession")) {
            sessionCookie = d.split(";")[0]
        }
        if (d.includes("TAUD")) {
            taudCookie = d.split(";")[0]
        }
    });
    return `${sessionCookie};${taudCookie}`
}

async function resolveInBatches(promiseArray, batchLength = 10) {
    const promises = [];
    for (const promise of promiseArray) {
        promises.push(promise);
        if (promises.length % batchLength === 0) await Promise.all(promises);
    }
    return Promise.all(promises)

}

async function getLocationId(searchString) {
    const result = await axios.post(`https://api.tripadvisor.com/api/internal/1.14/typeahead?alternate_tag_name=true&auto_broaden=true&default_options=?&category_type=neighborhoods%2Cgeos&currency=CZK&query=${searchString}`, {}, {headers: {"X-TripAdvisor-API-Key": API_KEY}})
    const data = result.data.data;
    if (!result.data.data) {
        throw new Error(`Could not find location "${locationFullName}"`);
    }
    return data[0].result_object.location_id;
}

async function getPlacePrices(placeId) {
    const date = new Date();
    const dateString = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    let response = await axios.get(`https://api.tripadvisor.com/api/internal/1.19/en/meta_hac/${placeId}?adults=2&checkin=2019-02-12&currency=USD&lod=extended&nights=1`, {headers: {"X-TripAdvisor-API-Key": API_KEY}})
    let offers = response.data.data[0].hac_offers;
    const isLoaded = offers && offers.availability && offers.availability !== "pending";
    if (!isLoaded) {
        await Apify.utils.sleep(300);
        return await getPlacePrices(placeId);
    }
    return offers

}

function buildHotelUrl(locationId, offset) {
    return `https://www.tripadvisor.com/Hotels-g${locationId}-${offset ? `oa${offset}` : ""}.html`;
}

async function getPlaceInformation(placeId) {
    const response = await axios.get(`https://api.tripadvisor.com/api/internal/1.14/location/${placeId}`, {headers: {"X-TripAdvisor-API-Key": API_KEY}})
    return response.data;
}

function getHotelIds($) {
    const hotelIds = [];
    const divs = $(".prw_rup.prw_meta_hsx_responsive_listing.ui_section.listItem");
    divs.each((index, element) => {
        const el = $(element).find(".meta_listing");
        const placeId = el.attr("data-locationid");
        const url = el.attr("data-url");
        const dataIndex = el.attr("data-index");
        hotelIds.push(placeId);
    });
    return hotelIds
}

const processReview = (review, remoteId) => {
    const {text, title, rating, tripInfo, publishedDate, userProfile,} = review;
    const stayDate = tripInfo ? tripInfo.stayDate : null;
    let userLocation = null;
    let userContributions = null;

    log.debug(`Processing review: ${title}`);
    if (userProfile) {
        const {hometown, contributionCounts} = userProfile;
        const {sumReview} = contributionCounts;
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
        remoteId
    };
};

async function getReviews(id, client) {
    const result = [];
    let offset = 0;
    let limit = 20;
    let numberOfFetches = 0;

    try {
        const resp = await callForReview(id, client, offset, limit);
        const {errors} = resp.data[0];

        if (errors) {
            log.exception(errors, "Graphql error")
        }

        const reviewData = resp.data[0].data.locations[0].reviewList;
        const {totalCount, reviews} = reviewData;
        const needToFetch = totalCount - limit;

        log.info(`Going to process ${totalCount} reviews`);

        numberOfFetches = Math.ceil(needToFetch / limit);
        reviews.forEach(review => result.push(processReview(review)));
    } catch (e) {
        log.error(e, "Could not make initial request")
    }

    try {
        for (let i = 0; i < numberOfFetches; i++) {
            offset += limit;
            const response = await callForReview(id, client, offset, limit);
            const reviewData = response.data[0].data.locations[0].reviewList;
            const {reviews} = reviewData;

            reviews.forEach(review => result.push(processReview(review)));
        }
    } catch (e) {
        log.error(e, "Could not make additional requests")
    }
    return result


}

async function processHotels(id, client, dataset) {
    const reviews = await getReviews(id, client);
    const placeInfo = await getPlaceInformation(id);
    const placePrices = await getPlacePrices(id);
    const prices = placePrices.offers.map(offer => ({
        provider: offer.provider_display_name,
        price: offer.display_price_int ? offer.display_price_int : "NOT_PROVIDED",
        isBookable: offer.is_bookable,
        link: offer.link
    }));
    const place = {
        id: placeInfo.location_id,
        name: placeInfo.name,
        awards: placeInfo.awards.map(award => ({year: award.year, name: award.display_name})),
        rankingPosition: placeInfo.ranking_position,
        priceLevel: placeInfo.price_level,
        category: placeInfo.ranking_category,
        rating: placeInfo.rating,
        hotelClass: placeInfo.hotel_class,
        hotelClassAttribution: placeInfo.hotel_class_attribution,
        phone: placeInfo.phone,
        address: placeInfo.address,
        amenities: placeInfo.amenities.map(amenity => amenity.name),
        prices,
        reviews
    };
    await dataset.pushData(place);
}

function buildRestaurantUrl(locationId, offset) {
    return `https://www.tripadvisor.com/RestaurantSearch?Action=PAGE&geo=${locationId}&ajax=1&sortOrder=relevance&${offset ? `o=a${offset}` : ""}&availSearchEnabled=false`
}

function getRequestListSources(locationId, placeTypes) {
    const sources = [];
    if (placeTypes.includes("HOTELS")) {
        sources.push({
            url: buildHotelUrl(locationId),
            userData: {initialHotel: true}
        })
    }
    if (placeTypes.includes("RESTAURANTS")) {
        sources.push({
            url: buildRestaurantUrl(locationId),
            userData: {initialRestaurant: true}
        })
    }
    return sources
}

function getRestaurantIds($) {
    const ids = [];
    $(".listing.rebrand").each((index, element) => {
        const split = $(element).attr("id").split("_");
        ids.push(split[split.length - 1]);
    });
    return ids
}
function getHours(placeInfo){
    const placeHolder = [];

    if (!placeInfo.hours) {
        return placeHolder;
    }

    if(!placeInfo.hours.week_ranges){
        return placeHolder;
    }

    return placeInfo.hours.week_ranges.map(wR => wR.map(day => ({open: day.open_time, close: day.close_time})));

}


async function processRestaurant(id, client, dataset) {
    const placeInfo = await getPlaceInformation(id);
    const reviews = await getReviews(id, client);
    const place = {
        id: placeInfo.location_id,
        name: placeInfo.name,
        awards: placeInfo.awards.map(award => ({year: award.year, name: award.display_name})),
        rankingPosition: placeInfo.ranking_position,
        priceLevel: placeInfo.price_level,
        category: placeInfo.ranking_category,
        rating: placeInfo.rating,
        isClosed: placeInfo.is_closed,
        isLongClosed: placeInfo.is_long_closed,
        phone: placeInfo.phone,
        address: placeInfo.address,
        cuisine: placeInfo.cuisine.map(cuisine => cuisine.name),
        mealTypes: placeInfo.mealTypes && placeInfo.mealTypes.map(m => m.name),
        hours: getHours(placeInfo),
        reviews
    };
    await dataset.pushData(place);

}

async function getClient() {
    const response = await axios.get("https://www.tripadvisor.com/");
    const $ = cheerio.load(response.data);
    return axios.create({
        baseURL: "https://www.tripadvisor.co.uk/data/graphql",
        headers: {
            "x-requested-by": getSecurityToken($),
            "Cookie": getCookies(response)
        }
    });
}

module.exports = {
    resolveInBatches,
    getHotelIds,
    getLocationId,
    buildHotelUrl,
    processHotels,
    getRequestListSources,
    buildRestaurantUrl,
    getRestaurantIds,
    processRestaurant,
    getClient
};
