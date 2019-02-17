const Apify = require('apify');
const {
    getHotelIds,
    resolveInBatches,
    processHotel,
    getRequestListSources,
    getRestaurantIds,
    processRestaurant,
    getClient,
    randomDelay,
    validateInput,
} = require('./tools/general');

const {
    getLocationId,
    buildRestaurantUrl,
    buildHotelUrl,
} = require('./tools/api');

const { utils: { log } } = Apify;


Apify.main(async () => {
    // Create and initialize an instance of the RequestList class that contains the start URL.
    const input = await Apify.getValue('INPUT');
    validateInput(input);
    const {
        locationFullName,
        includeRestaurants = true,
        includeHotels = true,
        includeReviews = true,
        lastReviewDate = '2010-01-01',
        hotelId,
        restaurantId,
    } = input;
    global.INCLUDE_REVIEWS = includeReviews;
    global.LAST_REVIEW_DATE = lastReviewDate;
    // const timeStamp = Date.now();
    let requestList;
    // let restaurants;
    // let hotels;
    const generalDataset = await Apify.openDataset();
    let locationId;
    if (locationFullName) {
        // restaurants = await Apify.openDataset(`restaurants-${timeStamp}`);
        // hotels = await Apify.openDataset(`hotels-${timeStamp}`);
        locationId = await getLocationId(locationFullName); // @TODO: ERROR could not obtain location id from search string;
        log.info(`Processing locationId: ${locationId}`);
        requestList = new Apify.RequestList({
            sources: getRequestListSources(locationId, includeHotels, includeRestaurants),
        });
    }

    if (restaurantId) {
        requestList = new Apify.RequestList({
            sources: [{ url: 'https://www.tripadvisor.com', userData: { restaurantId, restaurantDetail: true } }],
        });
    } else if (hotelId) {
        requestList = new Apify.RequestList({
            sources: [{ url: 'https://www.tripadvisor.com', userData: { hotelId, hotelDetail: true } }],
        });
    }

    await requestList.initialize();
    const requestQueue = await Apify.openRequestQueue();


    const crawler = new Apify.CheerioCrawler({
        requestList,
        requestQueue,
        handlePageFunction: async ({ request, $ }) => {
            let client;
            if (request.userData.initialHotel) {
                log.info(`Processing ${request.url}...`);
                // const numberOfHotels = $('.descriptive_header_text .highlight').first().text();
                const lastDataOffset = $('a.pageNum').last().attr('data-offset') || 0;
                const promises = [];
                for (let i = 0; i <= lastDataOffset; i += 30) {
                    promises.push(requestQueue.addRequest({
                        url: buildHotelUrl(locationId, i.toString()),
                        userData: { hotelList: true },
                    }));
                    await randomDelay();
                }
                await resolveInBatches(promises);
            } else if (request.userData.hotelList) {
                try {
                    client = await getClient();
                    log.info('PROCESSING HOTEL LIST ', request.url);
                    const hotelIds = getHotelIds($);
                    await resolveInBatches(hotelIds.map(id => processHotel(id, client, generalDataset)));
                } catch (e) {
                    log.error('Hotel list: Could not get client', e);
                }
            } else if (request.userData.initialRestaurant) {
                const promises = [];
                const maxOffset = $('.pageNum.taLnk').last().attr('data-offset') || 0;
                for (let i = 0; i <= maxOffset; i += 30) {
                    promises.push(requestQueue.addRequest({
                        url: buildRestaurantUrl(locationId, i.toString()),
                        userData: { restaurantList: true },
                    }));
                    await randomDelay();
                }
                await resolveInBatches(promises);
            } else if (request.userData.restaurantList) {
                client = await getClient();
                const restaurantIds = getRestaurantIds($);
                await resolveInBatches(restaurantIds.map(id => processRestaurant(id, client, generalDataset)));
            } else if (request.userData.restaurantDetail) {
                client = await getClient();
                await processRestaurant(request.userData.restaurantId, client);
            } else if (request.userData.hotelDetail) {
                client = await getClient();
                await processHotel(request.userData.hotelId, client);
            }
        },
        handleFailedRequestFunction: async ({ request }) => {
            log.info(`Request ${request.url} failed too many times`);
        },
    });

    // Run the crawler and wait for it to finish.
    await crawler.run();

    log.info('Crawler finished.');
});
