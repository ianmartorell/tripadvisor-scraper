const Apify = require('apify');
const axios = require("axios");
const {
    getHotelIds,
    getLocationId,
    buildHotelUrl,
    resolveInBatches,
    processHotel,
    getRequestListSources,
    buildRestaurantUrl,
    getRestaurantIds,
    processRestaurant,
    getClient,
    radnomDelay
} = require("./tools");

const {utils: {log}} = Apify;


Apify.main(async () => {
    // Create and initialize an instance of the RequestList class that contains the start URL.
    const input = await Apify.getValue("INPUT");
    const {locationFullName, placeTypes, includeReviews, lastReviewDate, hotelId, restaurantId} = input; //TODO: COMMENT IN README HOW THE LOCATION STRING SHOULD LOOK LIKE
    global.INCLUDE_REVIEWS = includeReviews;
    global.LAST_REVIEW_DATE = lastReviewDate;
    const timeStamp = Date.now();
    let requestList;
    let restaurants;
    let hotels;
    let locationId;
    if (locationFullName) {
        restaurants = await Apify.openDataset(`restaurants-${timeStamp}`);
        hotels = await Apify.openDataset(`hotels-${timeStamp}`);
        locationId = await getLocationId(locationFullName); //@TODO: ERROR could not obtain location id from search string;
        console.log(locationId, "LOCATIONID");
        requestList = new Apify.RequestList({
            sources: getRequestListSources(locationId, placeTypes)
        });
    }

    if (restaurantId) {
        requestList = new Apify.RequestList({
            sources: [{url: "https://www.tripadvisor.com", userData: {restaurantId, restaurantDetail: true}}]
        });
    }

    if (hotelId) {
        requestList = new Apify.RequestList({
            sources: [{url: "https://www.tripadvisor.com", userData: {hotelId, hotelDetail: true}}]
        });
    }

    await requestList.initialize();
    const requestQueue = await Apify.openRequestQueue();


    const crawler = new Apify.CheerioCrawler({
        requestList,
        requestQueue,
        handlePageFunction: async ({request, response, $, html}) => {
            let client;
            if (request.userData.initialHotel) {
                console.log(`Processing ${request.url}...`);
                const numberOfHotels = $(".descriptive_header_text .highlight").first().text();
                const lastDataOffset = $("a.pageNum").last().attr("data-offset") || 0;
                const promises = [];
                for (let i = 0; i <= lastDataOffset; i += 30) {
                    promises.push(requestQueue.addRequest({
                        url: buildHotelUrl(locationId, i.toString()),
                        userData: {hotelList: true}
                    }));
                    await radnomDelay();
                }
                await resolveInBatches(promises);
            } else if (request.userData.hotelList) {
                console.log("HOTELLIST");
                try {
                    client = await getClient();
                    console.log("PROCESSING HOTEL LIST ", request.url);
                    const hotelIds = getHotelIds($);
                    await resolveInBatches(hotelIds.map(id => processHotel(id, client, hotels)))
                }

                catch (e) {
                    log.error("Hotel list: Could not get client", e)
                }
            } else if (request.userData.initialRestaurant) {
                const promises = [];
                const maxOffset = $(".pageNum.taLnk").last().attr("data-offset") || 0;
                for (let i = 0; i <= maxOffset; i += 30) {
                    promises.push(requestQueue.addRequest({
                        url: buildRestaurantUrl(locationId, i.toString()),
                        userData: {restaurantList: true}
                    }));
                    await radnomDelay();
                }
                await resolveInBatches(promises);
            } else if (request.userData.restaurantList) {
                const restaurantIds = getRestaurantIds($);
                await resolveInBatches(restaurantIds.map(id => processRestaurant(id, client, restaurants)))
            } else if (request.userData.restaurantDetail) {
                client = await getClient();
                await processRestaurant(request.userData.restaurantId, client);
            }else if (request.userData.hotelDetail) {
                client = await getClient();
                await processHotel(request.userData.hotelId, client);
            }

        },
        handleFailedRequestFunction: async ({request}) => {
            console.log(`Request ${request.url} failed too many times`);
        },
    });

    // Run the crawler and wait for it to finish.
    await crawler.run();

    console.log('Crawler finished.');
});
